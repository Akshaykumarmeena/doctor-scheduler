# Phase 2 – Booking, in plain English

Phase 1 made double-booking *impossible to store*. Phase 2 builds the booking flow on top of that:
hold → confirm → cancel, safe under retries, races and crashes, and announcing every change as an event.

```
patient ──POST /holds──▶ slot: open → held (5 min)
        ──POST /appointments──▶ ONE transaction: slot held → booked + appointments row + outbox row
        ──POST /appointments/:id/cancel──▶ ONE transaction: appointment cancelled + slot → open + outbox row
                                         outbox ──relay──▶ Redpanda topic "appointments"
```

## 1. Holds instead of locks

A patient needs a minute or two to fill in details before committing. We can't hold a database lock that long:
locks are for milliseconds, and a closed browser tab would leave the lock open. So a **hold** is just data:
`status = 'held'`, `hold_id`, `hold_patient_id`, `hold_expires_at = now() + 5 min`.

Taking a hold is one statement:

```sql
UPDATE slots SET status = 'held', hold_id = gen_random_uuid(), ...
 WHERE id = $1
   AND (status = 'open' OR (status = 'held' AND hold_expires_at < now()))
RETURNING ...
```

The `WHERE` *is* the availability check, and it runs atomically with the write. When 50 requests arrive together,
Postgres row-locks the slot for the first UPDATE. The other 49 wait. When the first commits, each waiter
**re-checks its WHERE against the new row** (this is how READ COMMITTED treats UPDATE), finds `status = 'held'`,
and updates 0 rows. We turn "0 rows" into `409 Conflict`. The test `50 patients race for one slot` proves
exactly one wins.

Expiry is part of the condition, so an expired hold is free **immediately**, whether or not anything has cleaned it
up. The hold sweeper (every 10 s) only tidies stale rows. It is housekeeping, not correctness.

### Why not "check, then act"?

```
SELECT status FROM slots WHERE id = $1   -- 100 patients all see 'open'
... app code ...
UPDATE slots SET status = 'held' WHERE id = $1   -- 100 patients all "win"; last write silently wins
```

Run `npm run demo:race -- --naive` to watch it happen. Note that the exclusion constraint from Phase 1 does
**not** catch this: it compares *different* rows that overlap, and here everybody overwrites the *same* row.
So you need both guards:

| Guard | Protects against |
| --- | --- |
| `EXCLUDE (doctor_id =, during &&)` | two different held/booked rows overlapping in time |
| conditional `UPDATE ... WHERE status = 'open'` | two writers fighting over the same row |
| `version = version + 1` | lets a client say "update only if nobody changed it since I read version N" (optimistic concurrency, used later) |

## 2. Idempotency keys: retries are safe

Networks fail *after* the server has done the work: the client sees a timeout and retries. Without protection,
the retry books a second appointment. So every write must carry an `Idempotency-Key` (a UUID the client generates
once per user action and reuses on retry).

The server does this in **one transaction**:

1. `INSERT INTO idempotency_keys (key, request_hash) ... ON CONFLICT DO NOTHING`
2. If the insert succeeded, we own the key: run the business logic, store the response on the key row, `COMMIT`.
3. If the key existed: same request hash → **replay the stored response** (header `idempotent-replayed: true`).
   Different hash → `422` (a client bug: one key reused for a different request).

Because the key, the booking and the stored response commit together, there is no window where "the booking
happened but the key says otherwise". Two *concurrent* requests with the same key: the second `INSERT` waits on
the first one's uncommitted row (unique index), then sees it committed and replays it. Business rejections (409)
are stored too, so a retry gets the same answer. Unexpected errors (500) roll everything back, so a retry runs
fresh.

`appointments.idempotency_key UNIQUE` is a second safety net at the table level.

## 3. The transactional outbox

When a booking is confirmed, other systems must find out: the search index, the waitlist, notifications. The naive
way is to publish to Kafka from the API after committing. But:

- commit OK, publish fails → booked, and nobody hears about it
- publish OK, commit fails → everyone hears about a booking that doesn't exist

The **outbox** fixes both. The event is written as a row in the `outbox` table **in the same transaction** as
the booking: both exist or neither does. A separate **relay** (`services/workers/src/outbox-relay.ts`) then:

1. `SELECT ... FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`
2. publishes them to Redpanda, keyed by `doctor_id`
3. `UPDATE outbox SET published_at = now()`, then `COMMIT`

If the relay crashes between 2 and 3, the rows are published again on restart. That is **at-least-once**
delivery. Consumers must therefore be idempotent too, deduplicating on `eventId` (= `outbox.id`). Exactly-once is
expensive; at-least-once plus idempotent consumers is the standard answer.

`SKIP LOCKED` means a second relay instance skips rows the first has locked instead of waiting. You can run two
relays for availability, and they never publish the same row in the same moment.

### Kafka terms you will now see in Redpanda Console (http://localhost:8080)

- **Topic `appointments`**, 6 partitions. **Key = doctor_id**, so one doctor's events always land in the same
  partition and stay in order (booked before cancelled).
- **Producer idempotence** (`idempotent: true`) stops the broker from storing duplicates caused by the producer's
  own network retries. It does not cover relay crashes; that's what consumer-side dedupe is for.

## 4. Why the sweeper lives in booking-api

Invariant 1: *the booking API is the only writer of `slots`.* The hold sweeper writes slots, so it runs inside
the booking-api process, not in `services/workers`. The workers only touch the `outbox`.

## 5. Interview lines

- "A hold is data with a TTL, not a lock. Availability is decided by one conditional UPDATE, so the database
  serialises racers. Expiry is part of the predicate, so correctness doesn't depend on a cleanup job."
- "Every write takes an idempotency key, stored in the same transaction as the effect, so retries replay the
  original answer."
- "Events go through a transactional outbox with an at-least-once relay keyed by doctor_id. Consumers dedupe by
  event id."
