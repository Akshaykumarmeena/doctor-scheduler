# 0003 – Search is an OpenSearch read model rebuilt from Postgres on events

Status: accepted (Phase 3, 2026-10-29)

## Context

Patients search 5,000 doctors by free text, specialty, language, area or distance, and "free on day X", with
ranking. That is a search-engine workload. Postgres stays the only source of truth for availability.

## Decisions

1. **One OpenSearch document per doctor** in index `doctors_v<timestamp>`, always accessed through the alias
   `doctors`. Fields: full-text `name`/`clinic`, keyword+text `specialty`/`area`, keyword `languages`,
   `geo_point` location, `rating`, `next_available`, `available_dates` (local dates with a free slot), `open_slots`.
   `dynamic: strict` so unknown fields fail loudly.
2. **Events are notifications, Postgres is the truth.** The `search-indexer` consumer group reads topic
   `appointments`. For each batch it collects the distinct doctor ids, re-reads their availability from Postgres
   and bulk-upserts the documents (`_id` = doctor id). That makes it idempotent and order-insensitive, which is
   what at-least-once delivery needs. Offsets are committed only after OpenSearch accepted the writes.
   *Rejected:* applying event payloads as deltas (needs ordering + dedupe); CDC (more infrastructure).
3. **Holds are not indexed.** They last minutes and would churn the index; search says "likely available" and the
   booking path re-checks in Postgres. Only bookings and cancellations change a document.
4. **Zero-downtime full rebuild**: `npm run search:reindex` fills a new index, then swaps the alias in one atomic
   `_aliases` call and deletes the old index. The indexer builds the index on start-up if the alias is missing.
   Known gap: events during a rebuild land on the old index; the next event for that doctor fixes it
   (production would replay from an offset captured before the rebuild).
5. **Query** (`buildSearchQuery`): exact constraints in `bool.filter` (unscored, cached), free text in
   `bool.must` as prefix-OR-fuzzy `multi_match` (name^3, specialty^2; `bool_prefix` for search-as-you-type,
   fuzziness AUTO for typos), ranking = text score × log(2 + rating) (`log2p`, never 0 for unrated doctors).
   Sorts: relevance, rating, soonest, distance (only with a point).
6. **Search failing must not break booking**: `/search` returns 503 `search_unavailable` when OpenSearch is down;
   all booking endpoints are independent of it.
7. **Plain REST over fetch** for OpenSearch (no SDK), like plain SQL for Postgres: every request is visible JSON.

## Consequences

- Search can lag bookings by about a second (relay poll + consumer); the UI says so.
- The materializer adds new days of slots without emitting events, so run `npm run search:reindex` after
  `npm run db:materialize` (a nightly job in production).
- CI runs an OpenSearch service container.
