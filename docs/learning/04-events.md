# Phase 4 – Events: live updates, inbox, waitlist offers, reminders

```
booking-api ──outbox (same tx)──▶ relay ──▶ Redpanda "appointments" (key = doctor_id)
                                               │
          ┌──────────────────┬─────────────────┼──────────────────┬───────────────────┐
   search-indexer       live-fanout         notifier         waitlist-matcher     (reminders: a timer,
   (OpenSearch)      (Redis doctor:<id>)  (inbox rows)      (offers = holds via    not Kafka)
                            │                                  booking-api HTTP)
                     booking-api SSE ──▶ browser
```

## 1. One topic, many consumer groups

Every consumer above is its own **consumer group**, so Kafka keeps a separate offset for each. They all see every
event, each at its own pace. If OpenSearch is down, the search indexer stalls and its lag grows, but the notifier
and matcher carry on. Open Redpanda Console → Consumer Groups to see all four and their lag.

New events this phase: `hold.created`, `hold.released`, `hold.expired`, written in the same transaction as the
hold change, just like bookings. The search indexer ignores them (holds aren't indexed).

## 2. Live updates (ADR 0005)

- **SSE** (Server-Sent Events): the browser opens `GET /doctors/:id/slots/stream?date=…` and keeps it open. The
  server writes `event: slots-changed` frames whenever something changes on that day. `EventSource` reconnects
  by itself.
- **Fan-out**: one `live-fanout` consumer publishes each event to Redis channel `doctor:<id>`. Every API
  instance subscribes once and forwards to its own browsers. That's why it works with 1 or 10 API servers.
- **Redis pub/sub is fire-and-forget.** That's fine because the event only means "refetch"; Postgres has the truth.
- A real race we hit and fixed: the stream used to say `: connected` *before* subscribing to Redis, so a message
  published right then was lost. Now it subscribes first.

## 3. The inbox: idempotent consumers

At-least-once delivery means the notifier *will* see some events twice. Every notification has a `dedupe_key`
(`event:<eventId>:booked`, `offer:<holdId>`, `<appointmentId>:reminder_1h`, …) with a UNIQUE index, and the insert
is `ON CONFLICT (dedupe_key) DO NOTHING`. A duplicate delivery inserts nothing: **exactly-once effect on top of
at-least-once delivery.**

## 4. Waitlist offers (ADR 0006): the cascade

1. Patients join a doctor's waitlist for a day (`POST /waitlist`).
2. A slot frees up (cancel, or a hold released/expired) → the event reaches `waitlist-matcher`.
3. The matcher locks the **oldest waiting** entry (`FOR UPDATE SKIP LOCKED`) and asks booking-api for a 10-minute
   hold on that slot *for that patient*. It never writes `slots` itself: invariant 1 holds.
4. Entry → `offered`, plus an "A slot opened up for you" message, live in the inbox.
5. Accept → the normal confirm → `appointment.booked` → entry `booked`.
   Decline or ignore → `hold.released` / `hold.expired` → entry closed → **back to step 2 for the next person**.

Why `SKIP LOCKED`? With two matchers running, the second one doesn't wait for the first; it skips to the next
person, and booking-api's hold decides who actually gets the slot (only one hold can win).

Why `causeEventId` in the Idempotency-Key? If the batch is redelivered after the hold was created, the retry gets
the **same** hold back instead of a 409, so it can finish recording the offer.

## 5. Reminders: when you don't need Kafka

"Remind 24 h and 1 h before" is a question about *time*, not about an event. A loop every minute inserts
reminders for confirmed appointments inside the window, with `dedupe_key = <appointmentId>:<kind>`. It's safe to
run on two machines or to restart. `REMINDER_LEAD_MINUTES=10,2` makes it fire quickly for a demo.

## 6. Closed tab and "one patient, one place" (ADR 0007)

- **Lease + heartbeat:** a hold from the booking page lives 2 minutes and the open page renews it every 30 s,
  up to a 5-minute deadline. Close the tab and the renewals stop, so the slot frees within ~2 minutes. Reopen in
  time and the page resumes your hold. A lease is the standard answer to "how do you detect a client that went
  away?": you can't be told reliably, so make the client keep proving it's there.
- **Per-patient EXCLUDE:** the same `tstzrange` + `EXCLUDE` trick as Phase 1, keyed by patient instead of doctor:
  no overlapping holds, and (via `appointments.during`) no overlapping confirmed appointments, across all doctors.
  Plus a cap of 3 live holds per patient.
- **But:** it only works in one database. Shard by doctor and a patient's rows are spread out, so the check must
  move to something keyed by patient. Know this trade-off for the interview.

## 7. Break it

1. **Cascade:** put 2–3 patients on a waitlist for a booked day, cancel the booking, let the first offer expire
   (`OFFER_TTL_SECONDS=60 npm run dev` for a fast demo). Watch it move down the line in My appointments and the inbox.
2. **Two windows:** open the same doctor/day twice and book in one. The other updates by itself ("● live").
3. **Redis down:** `docker compose stop redis`. Live updates and badges pause; booking and the inbox still work.
   `docker compose start redis`.
4. **Duplicate delivery:** the tests replay the same event; still one notification, still one offer.

## 8. Interview lines

- "Every downstream reaction is its own consumer group on one topic, with independent offsets and failure isolation."
- "Consumers are idempotent: a dedupe key with a UNIQUE index turns at-least-once delivery into exactly-once effects."
- "Live updates: one fan-out consumer → Redis pub/sub → SSE from any API instance; events are notifications, the
  client refetches."
- "Waitlist offers are just holds made through the booking API, so they inherit all the double-booking guarantees."
- "Abandoned holds: a short lease renewed by heartbeats, under a hard deadline."
- "Per-patient overlap is the same exclusion constraint keyed by patient, until you shard by doctor; then it
  becomes a per-patient check in the booking flow."
