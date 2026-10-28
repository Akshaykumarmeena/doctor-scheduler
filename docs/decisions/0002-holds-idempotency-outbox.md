# 0002 – Holds with TTL, idempotency keys in the business transaction, transactional outbox

Status: accepted (Phase 2, 2026-10-28)

## Context

Booking is two steps for the patient (pick a time, then confirm), it runs over unreliable networks, and other
systems (search, waitlist, notifications) must learn about every change without being able to break it.

## Decisions

1. **Holds are rows with a TTL (5 min), not database locks.** `POST /holds` is a single conditional UPDATE
   (`status = 'open'` or an expired hold). An expired hold is treated as free by the predicate itself; a sweeper
   inside booking-api reopens stale rows every 10 s as housekeeping only.
   *Rejected:* `SELECT ... FOR UPDATE` held across user think-time (locks for minutes, leaks on disconnect);
   Redis locks (a second source of truth for availability).

2. **Idempotency keys are claimed, used and answered in the same Postgres transaction as the effect.**
   Same key + same request hash → replay the stored response; different hash → 422; concurrent duplicates
   serialize on the unique index and the loser replays. 2xx and 4xx outcomes are stored; 5xx rolls back.
   *Rejected:* storing the key in Redis or in a separate transaction (crash windows where the effect and the
   key disagree); a visible "in progress → 409" state (unnecessary when the second request can wait and replay).

3. **Events leave through a transactional outbox, relayed at-least-once to Redpanda**, topic `appointments`,
   key = `doctor_id`, idempotent producer, `FOR UPDATE SKIP LOCKED` batches. Consumers dedupe on `eventId`.
   *Rejected:* publishing from the request handler (dual-write problem); CDC/Debezium (more infrastructure than a
   demo needs; a natural later upgrade).

4. **`slots.hold_patient_id`** (schema 0008) records whose hold it is, so confirm books for the holder, not for
   whoever presents the hold id. A CHECK keeps all hold columns set together and only on held rows.

5. **Single-slot bookings only in Phase 2.** Variable-length visits (one 30-minute booking over two 15-minute
   slots) are deferred to Phase 3.

## Consequences

- Any number of booking-api instances can run; correctness lives in Postgres.
- Downstream consumers must be idempotent (at-least-once).
- No authentication yet: `patientId` is taken from the request body. That is a demo shortcut and must be
  replaced by the authenticated user before anything real.
