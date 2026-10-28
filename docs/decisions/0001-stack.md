# 0001 – Stack: Postgres, Redpanda, OpenSearch, Redis, plain SQL, TypeScript monorepo

Status: accepted (Phase 1, 2026-10-28)

## Context

We are building a doctor-appointment platform whose hardest requirement is **never double-book a doctor**, while
also supporting search ("cardiologist in Koramangala who speaks Kannada, tomorrow morning"), reacting to events
(cancellations fill from the waitlist) and surviving partial failures. It must run free on one laptop.

## Decisions

**Postgres 16 is the source of truth for slots and appointments.**
Double-booking prevention needs a transactional store that can enforce "no two commitments overlap" itself.
Postgres has range types (`tstzrange`) and exclusion constraints (`EXCLUDE USING gist`), so the rule lives in the
schema, not in application code that every future writer would have to remember. It also gives us row locks,
`SELECT ... FOR UPDATE SKIP LOCKED` for workers, and partial indexes. Sharding later is by `doctor_id`, which is why
every booking table carries it: a booking never spans two doctors, so it never spans two shards.

**Redpanda for events (Kafka API).**
Things that react to bookings (search index, waitlist, notifications, analytics) should not slow down or break the
booking transaction. They consume events from a log instead. Redpanda speaks the Kafka protocol, so the code and
concepts are Kafka's (topics, partitions, consumer groups, offsets), but it is one binary with no ZooKeeper or JVM,
which matters on a laptop. Events are written to an `outbox` table in the same transaction as the state change
and relayed to Redpanda afterwards, so we never have "booked but no event" or "event but no booking".

**OpenSearch for doctor search.**
Full-text plus filters plus geo-distance plus ranking is what a search engine is for; doing it in Postgres works
at small scale but competes with booking traffic for the same database. OpenSearch is the open-source
Elasticsearch fork (Apache-2.0), so it is free to run. It is a *derived* read model fed from events: it may lag by
seconds, and the booking API always re-checks availability in Postgres.

**Redis for caching and rate limiting only.**
Hot reads (doctor profiles, "slots for tomorrow" summaries) and per-patient rate limits. Redis is never the
authority on whether a slot is free; losing Redis makes things slower, not wrong.

**Plain SQL with `pg`, no ORM.**
The interesting parts of this system are SQL: exclusion constraints, conditional updates with version checks,
`ON CONFLICT`, `SKIP LOCKED`. An ORM would hide exactly what we want to learn and review. Queries are
parameterized (`$1`), so this is no less safe.

**TypeScript monorepo with npm workspaces.**
One language for web, API and workers; shared types in `packages/shared` keep the API contract and UI in sync;
one `npm install`, one CI job. npm workspaces because they need nothing extra installed (pnpm would also work).

## Consequences

- Five containers locally (~2 GB RAM). OpenSearch Dashboards is skipped to save memory.
- Search results can be briefly stale; booking correctness never depends on them.
- We own our SQL and migrations, so schema changes are reviewed as SQL.
