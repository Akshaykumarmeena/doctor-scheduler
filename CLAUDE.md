# doctor-scheduler

A demo doctor-appointment platform that **cannot double-book**, keeps working when parts of it fail,
and fills empty and no-show slots automatically. It is also a learning project: Akshay is preparing
for a tech-lead interview and builds it phase by phase.

## Architecture (target)

```
apps/web (Next.js)  ──HTTP──▶  services/booking-api (Fastify, plain SQL)  ──▶  Postgres (source of truth)
                                        │  writes outbox rows in the same tx
                                        ▼
                     services/workers: outbox relay ──▶ Redpanda (Kafka API) ──▶ indexer ──▶ OpenSearch
                                       waitlist matcher                          (doctor search)
                     (the hold sweeper runs inside booking-api: only the API writes slots)
                     Redis: caches / rate limits (never the source of truth for availability)
```

Phase 1: infra, schema, seed, slot materializer, `/health`, `/doctors`.
Phase 2: holds (5-min TTL), confirm, cancel, idempotency keys, transactional outbox + relay to Redpanda,
hold sweeper (inside booking-api), booking UI. Single-slot bookings only; 30-min visits are Phase 3.

## Invariants (do not break these)

1. **The booking API is the only writer of `slots`.** Workers, web and scripts never update slot status directly.
   (Exceptions: the seed script and the materializer, which only insert `open` rows. The hold sweeper runs
   inside booking-api for this reason. `scripts/race.ts --naive` breaks it on purpose and resets.)
2. **Every write is idempotent.** Mutating endpoints take an `Idempotency-Key` header; the stored response in
   `idempotency_keys` is replayed on retry; `appointments.idempotency_key` is UNIQUE.
3. **All times are stored in UTC** (`timestamptz` / `tstzrange`). A doctor has an IANA `tz`; templates are in local
   time and are converted when slots are materialized. Never store local wall-clock time in a slot.

Also: every booking table carries `doctor_id` (future shard key and Kafka partition key), and events leave the
database only through the transactional `outbox`.

The double-booking guard is the `slots_no_overlapping_commitments` EXCLUDE constraint
(`doctor_id WITH =, during WITH &&` for `held`/`booked`). Do not weaken or drop it.

## Layout

- `apps/web` – Next.js App Router UI
- `services/booking-api` – Fastify API, `pg` with hand-written SQL (no ORM: the SQL must stay visible)
- `services/workers` – background workers (skeleton in Phase 1)
- `packages/shared` – TypeScript types shared across apps
- `db/migrations` – numbered plain `.sql` files; `db/migrate.ts` applies them; `db/seed.ts` seeds synthetic data
- `docs/decisions` – ADRs; `docs/learning` – plain-English explainers per phase

## Commands (npm workspaces)

| Command | What it does |
| --- | --- |
| `npm run dev:infra` | `docker compose up -d --wait` (Postgres, Redis, Redpanda + Console, OpenSearch) |
| `npm run db:migrate` | Apply new schema files to `DATABASE_URL` |
| `npm run db:seed` | Insert ~5,000 doctors, templates, ~300 patients (idempotent: skips if seeded) |
| `npm run db:materialize` | Expand templates minus exceptions into slots for the next 14 days (safe to re-run) |
| `npm run dev` | booking-api on :4000, web on :3000, workers (outbox relay) |
| `npm run demo:race [-- --naive]` | 100 patients race for one slot (API mode needs `npm run dev`) |
| `npm run lint` / `npm run typecheck` / `npm test` | Checks; tests use a throwaway `scheduler_test` DB |

URLs: web http://localhost:3000 · API http://localhost:4000/health · Redpanda Console http://localhost:8080 ·
OpenSearch http://localhost:9200

## Working rules

- **Akshay writes the critical piece of each phase himself.** Claude scaffolds around it, explains, and reviews,
  but does not write that piece unless Akshay asks. (Phase 1: the schema review of `slots` + EXCLUDE.
  Phase 2: `services/booking-api/src/booking/confirm.ts`, the confirm transaction.)
- Show a plan before multi-file changes; small commits, one logical change each; never push without Akshay's OK.
- Plain SQL only. If a query matters, it should be readable in the code.
- Zero spend: everything runs locally in Docker; no paid or cloud services.
