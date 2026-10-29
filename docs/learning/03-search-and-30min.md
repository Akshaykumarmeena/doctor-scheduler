# Phase 3 – Search, patient screens and 30-minute visits, in plain English

```
booking-api ──outbox──▶ relay ──▶ Redpanda "appointments" ──▶ search-indexer (consumer group)
                                                                  │ re-read doctor from Postgres
                                                                  ▼
patient ──GET /search──▶ booking-api ──▶ OpenSearch alias "doctors" ──▶ doctors_v<timestamp>
```

## 1. How OpenSearch finds things: the inverted index

A database index answers "row with id X". A search engine answers "which documents contain these words?". When a
doctor document is indexed, each `text` field is **analysed**: lower-cased and split into terms
("Dr. Priya Nair" → `dr`, `priya`, `nair`). OpenSearch stores, per term, the list of documents containing it: the
**inverted index**. A query for "priya" is a dictionary lookup, not a table scan.

Two field types matter:

| Type | Stored as | Used for |
| --- | --- | --- |
| `text` | analysed terms | full-text match, typo tolerance, relevance scoring |
| `keyword` | the exact value | filters, sorting, facets ("Cardiology" exactly) |

`specialty` and `area` are both: `keyword` for filters, plus a `.text` sub-field for free text.

## 2. Filter vs query: the interview question

```json
{ "bool": {
    "must":   [ { "multi_match": { "query": "cardio", "fields": ["name^3", "specialty.text^2", "clinic", "area.text"], "fuzziness": "AUTO" } } ],
    "filter": [ { "term": { "languages": "Kannada" } }, { "term": { "available_dates": "2026-11-02" } },
                { "geo_distance": { "distance": "3km", "location": { "lat": 12.93, "lon": 77.62 } } } ] } }
```

- **filter**: yes/no. It doesn't affect the score, and the result set is cached per segment, so it is cheap.
  Everything exact goes here.
- **must**: scored with BM25 (rare terms and short fields weigh more). Only the fuzzy free text goes here.
- **function_score × log1p(rating)**: a better-rated doctor edges ahead at equal relevance, but rating never beats
  relevance outright.

`fuzziness: AUTO` allows 1–2 edits depending on word length, so "cardiolgy" and "priyaa" still match.

## 3. Kafka consumers: groups, offsets, lag

- A **consumer group** (`search-indexer`) is one logical reader. Kafka stores its **committed offset** per
  partition: "I have processed up to message N".
- Our 6 partitions are split among the group's running members. Start a second worker and they share the load.
- **Lag** = newest offset − committed offset = how far behind the indexer is. You'll see it in Redpanda Console →
  Consumer Groups.
- We commit **after** OpenSearch accepted the write. Crash before commit → the batch is redelivered → we index again.
  That is at-least-once, and it's safe because:

## 4. Events are notifications; the database is the truth

The indexer doesn't apply "slot X was booked" to the document. It treats the event as "doctor X changed", re-reads
that doctor's availability from Postgres, and overwrites the whole document. So:

- the same event twice → same document (**idempotent**)
- events out of order → the last rebuild reflects the database *now* (**order-insensitive**)
- a lost event (it can't be lost with the outbox, but even so) → the next event or a reindex heals it

This is **CQRS**: writes go to Postgres; reads for search come from a model *derived* from it. The read model is
**eventually consistent**, usually about a second behind. That's why booking always re-checks in Postgres, and the
UI says "availability may lag".

## 5. Zero-downtime reindex with an alias

Searches use the alias `doctors`, never a physical index. `npm run search:reindex` builds `doctors_v<now>`, then one
atomic `_aliases` call moves the alias and the old index is deleted. Searchers never see a half-built index.
This is how you change a mapping in production.

## 6. 30-minute visits: the EXCLUDE constraint pays off

A 30-minute hold inserts **one composite row** `[09:00, 09:30)` as `held`. The base rows underneath stay `open`,
but the constraint from Phase 1 now refuses any held/booked row of this doctor that overlaps `[09:00, 09:30)`:

| Attempt | Result |
| --- | --- |
| 15-min hold on 09:15 while the 30-min hold is live | `23P01` exclusion violation → 409 |
| 30-min hold 09:00–09:30 while 09:15 is booked | `23P01` → 409 |
| 30-min hold 09:30–10:00 | allowed, no overlap |

This is the exact case from your Phase 1 explain-back: a `UNIQUE (doctor_id, start)` would see 09:00 ≠ 09:15 and
let both through.

One subtlety: EXCLUDE counts every `held` row, *even expired ones*. So before taking any hold, we release expired
holds that overlap the requested time, in the same transaction. Otherwise a stale hold would block the slot until
the sweeper ran.

## 7. Break it

1. **Stale search.** Stop the workers (`Ctrl+C` in `npm run dev`, then run only `npm run dev -w @ds/booking-api`
   and `npm run dev -w @ds/web`). Book every slot of a doctor for one day. Search "free on that day": still listed.
   Redpanda Console shows the lag growing. Start `npm run dev -w @ds/workers`: it resumes from its committed offset,
   catches up, and the doctor disappears from that day.
2. **Search down, booking up.** `docker compose stop opensearch`: `/search` returns 503, but holds, confirm and cancel
   work. `docker compose start opensearch` to recover.
3. **15 vs 30 race.** The test `50 racers mixing 15- and 30-minute holds` throws three kinds of overlapping holds
   at once; the overlap count is always 0.

## 8. Interview lines

- "Search is a read model: OpenSearch fed by a Kafka consumer, eventually consistent, never trusted for booking."
- "The consumer treats events as notifications and rebuilds from the source of truth, so at-least-once delivery
  is harmless."
- "Exact constraints go in filter context, free text in query context; rank by BM25 times a rating factor."
- "Mapping changes ship as a new index behind an alias with an atomic swap."
- "Variable-length bookings are just ranges; an exclusion constraint on (doctor, range) makes overlaps impossible
  regardless of slot size."
