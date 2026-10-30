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
hold sweeper (inside booking-api), booking UI.
Phase 3: OpenSearch search read model fed by the `search-indexer` consumer group, `/search` API and page, patient
screens (search, slot grid with countdown, My appointments), 30-minute visits as composite slot rows (ADR 0004).
Phase 4: hold.* events, live slot updates (live-fanout → Redis → SSE), patient inbox (notifier), waitlist offers
(waitlist-matcher holds freed slots for the next patient through booking-api, cascading), reminders,
closed-tab hold leases (heartbeat), and per-patient overlap guards (a patient can't be in two places at once).
Phase 5: doctor app (/doctor): week view, working hours (from tomorrow; bookings outside new hours kept and
flagged), time off (preview, then cancel + notify; blocks slots), Done / No-show, utilization numbers (ADR 0008).
Phase 6: engineering console (/console) backed by a DEV-ONLY ops service (services/ops, 127.0.0.1:4100,
OPS_ENABLED=1): service stop/start, race, live events, consumer lag, live invariants, k6 load tests with a rolling
restart; graceful shutdown in booking-api; 2 APIs behind nginx in `npm run dev:cluster` (ADR 0009).
The full plan and the "changes vs plan" log are in [docs/ROADMAP.md](docs/ROADMAP.md).

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

Per patient, `slots_patient_no_overlapping_holds` and `appointments_patient_no_overlap` do the same (ADR 0007).
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
| `npm run search:reindex` | Rebuild the OpenSearch `doctors` index from Postgres and swap the alias (run after materialize) |
| `npm run dev` | booking-api on :4000, web on :3000, workers (relay, search-indexer, live-fanout, notifier, waitlist-matcher, reminders) |
| `OFFER_TTL_SECONDS=60 REMINDER_LEAD_MINUTES=10,2 npm run dev` | Same, with fast waitlist offers and reminders for a demo |
| `npm run dev:cluster` | Instead of `npm run dev`: 2 APIs behind nginx on :4000, workers, web, and the ops service on :4100 (needed for /console) |
| `npm run demo:race [-- --naive]` | 100 patients race for one slot (API mode needs `npm run dev`) |
| `npm run lint` / `npm run typecheck` / `npm test` | Checks; tests use a throwaway `scheduler_test` DB |

URLs: web http://localhost:3000 · API http://localhost:4000/health · Redpanda Console http://localhost:8080 ·
OpenSearch http://localhost:9200

## Working rules

- **Akshay writes the critical piece of each phase himself.** Claude scaffolds around it, explains, and reviews,
  but does not write that piece unless Akshay asks. (Phase 1: the schema review of `slots` + EXCLUDE.
  Phase 2: `services/booking-api/src/booking/confirm.ts`, the confirm transaction.
  Phase 3: `services/booking-api/src/search/query.ts`, the search query builder.
  Phase 4: `services/workers/src/waitlist/matcher.ts`, the waitlist matcher's pick-and-offer step.
  Phase 5: `services/booking-api/src/doctor/time-off.ts` `addTimeOff()`, the time-off transaction.
  Phase 6: `services/booking-api/src/shutdown.ts` + `infra/nginx/cluster.conf`, graceful shutdown and retry policy.)
- Show a plan before multi-file changes; small commits, one logical change each; never push without Akshay's OK.
- **Ask before deviating from an approved plan**, and add every deviation to the "Changes vs plan" log in
  `docs/ROADMAP.md`. Every PR updates that log.
- Plain SQL only. If a query matters, it should be readable in the code.
- Zero spend: everything runs locally in Docker; no paid or cloud services.
- The ops service (services/ops) is dev-only. Never expose it, never add ops endpoints to booking-api.
