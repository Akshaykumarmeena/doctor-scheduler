# Phase 1 – Foundations, in plain English

This phase builds no booking features. It sets up the ground every later phase stands on: the infrastructure,
the database schema (including the rule that makes double-booking impossible), realistic data, and a way to turn
weekly schedules into bookable slots.

## 1. Docker Compose: the whole platform on one laptop

`docker-compose.yml` describes five containers. `npm run dev:infra` starts them and waits until each one's
**healthcheck** passes (a small command Docker runs repeatedly, such as `pg_isready` for Postgres).

| Service | Port | Role in this system |
| --- | --- | --- |
| Postgres 16 | 5432 | Source of truth: doctors, slots, appointments |
| Redis 7 | 6379 | Cache and rate limits. You know this one. |
| Redpanda | 9092 | Event log, Kafka-compatible (below) |
| Redpanda Console | 8080 | Web UI to browse topics and messages |
| OpenSearch 2 | 9200 | Search engine for doctor search (below) |

Each container has a memory limit so the stack can't eat the laptop (about 1.7 GB in use when idle).

### Kafka / Redpanda, if you know caching but not Kafka

A cache answers "what is the value now?" and throws old values away. Kafka is the opposite: an **append-only
log** of things that happened ("appointment booked", "slot freed"), kept for days, which many readers can each
replay at their own pace.

- A **topic** is a named log, such as `appointments`.
- A topic is split into **partitions** so it can scale. Messages with the same **key** always go to the same
  partition, in order. We will key by `doctor_id`, so all events for one doctor stay in order.
- A **consumer group** is one logical reader (for example "search-indexer"). Kafka remembers its **offset**,
  meaning how far it has read. If the indexer crashes, it resumes where it stopped. Nothing is lost, and nothing
  slows the booking API down.

Redpanda implements the same protocol in a single binary, so we learn Kafka without running ZooKeeper or a JVM.
In Phase 1 we only check that it is reachable. The Console at :8080 will show topics once Phase 2 publishes events.

### OpenSearch, if you know caching but not search engines

OpenSearch (the open-source fork of Elasticsearch) stores JSON **documents**, one per doctor, in an **index**.
For every word it keeps an **inverted index**: a map from a term such as "cardiology" to the documents that
contain it. That makes "free text + filters + distance from me + sort by rating" fast, and ranks results by
relevance. Think of it as a very smart read cache built from events. It can lag a few seconds behind Postgres,
so the booking API never trusts it about availability. Phase 1 only checks that it is reachable.

## 2. Schema changes as numbered SQL files

The schema lives in `db/migrations/0001_*.sql … 0007_*.sql`. `db/migrate.ts` applies, in order, every file not yet
recorded in the `schema_migrations` table, each file in its own transaction. So a half-applied file rolls back
cleanly, and re-running the script only applies new files. A Postgres advisory lock stops two runners from racing
each other. We use plain SQL so every constraint and index stays visible and reviewable.

Tables: `doctors`, `patients`, `schedule_templates` (weekly rules, in local time), `schedule_exceptions` (leave
or holidays, as UTC ranges), `slots`, `appointments`, `waitlist_entries`, `outbox`, `idempotency_keys`.

## 3. The core idea: `tstzrange` + an exclusion constraint

A slot's time is one column, `during tstzrange`: a range of UTC instants written as `[start, end)`. The square
bracket means start is included; the round bracket means end is excluded. So 09:00–09:15 and 09:15–09:30 touch but
do not overlap.

The rule against double-booking is enforced by the database:

```sql
EXCLUDE USING gist (doctor_id WITH =, during WITH &&) WHERE (status IN ('held', 'booked'))
```

Read it as: "no two held or booked rows may have an equal `doctor_id` **and** overlapping (`&&`) time ranges".
Postgres checks this on every insert and update, using a GiST index. `btree_gist` is the extension that lets one
GiST index mix `=` on a uuid with `&&` on a range.

**Why not `UNIQUE (doctor_id, start_time)`?** A unique constraint only catches *identical* values. Say
Patient 1 has booked 09:15–09:30, and Patient 2 now tries to book a 30-minute visit 09:00–09:30. The start times
differ (09:00 vs 09:15), so the unique constraint is satisfied and the doctor is double-booked from 09:15 to
09:30. The exclusion constraint compares *ranges*, sees that they overlap, and rejects the second booking with
`ERROR: conflicting key value violates exclusion constraint "slots_no_overlapping_commitments"`.
Try it: `docker compose exec -T postgres psql -U scheduler -d scheduler < docs/learning/break-it.sql`.

Why the database and not application code? Two API instances can both check "is it free?", both see yes, and both
write. That is a race. The constraint is checked atomically inside the database, so the second writer always loses,
whatever code, retry or future service wrote the row.

Only `held` and `booked` rows are policed. `open` rows may overlap (for example a 30-minute candidate on top of two
15-minute slots), because overlap only matters once someone commits to the time.

## 4. The materializer: from weekly rules to concrete slots

Doctors think in rules ("Mon–Fri 9–1, 15-minute slots"); patients book concrete times. The materializer expands
each doctor's `schedule_templates` for the next 14 days, converts local time to UTC using the doctor's IANA `tz`,
drops slots that overlap a `schedule_exceptions` range, and inserts the rest as `open` slots.

It is **idempotent**: `UNIQUE (doctor_id, during)` plus `INSERT … ON CONFLICT DO NOTHING` means running it again
inserts nothing new, so it can run nightly (in production: 60 days ahead) without creating duplicates. The UTC
conversion is the whole point of "store UTC": 09:00 in Asia/Kolkata is stored as 03:30Z. India has no daylight
saving, but a doctor in Europe would, and computing from `tz` at materialization time handles that correctly.

## 5. What to say in the interview

- "Correctness invariants belong in the database when they can: an exclusion constraint on a time range makes
  double-booking impossible regardless of how many writers or races there are."
- "Search and events are derived and may lag. The booking path never trusts them for availability."
- "Writes are idempotent (idempotency keys) and events leave through a transactional outbox, so retries and
  crashes do not create duplicates or lose events."
