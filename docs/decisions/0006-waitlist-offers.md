# 0006 – Waitlist offers are holds made by a matcher through the booking API

Status: accepted (Phase 4, 2026-10-29)

## Context

When a slot frees up, the patient who has waited longest for that doctor and day should get first refusal,
without anyone else grabbing it in the meantime, and without breaking "only the booking API writes slots".

## Decisions

1. **An offer is a hold.** The `waitlist-matcher` consumer group asks booking-api over HTTP for a hold on behalf
   of the waiting patient (`POST /holds` with `ttlSeconds: 600`). Nobody else can take the slot while the offer is
   open, and accepting is just the normal confirm (`POST /appointments {holdId}`).
2. **Head of the line** = the oldest `waiting` entry whose wanted day contains the freed slot, selected with
   `FOR UPDATE SKIP LOCKED`, so two matchers never offer to the same person, and a busy entry doesn't block.
3. **Triggers:** `appointment.cancelled`, and `hold.released` / `hold.expired`. That covers declined or ignored
   offers (the cascade) and any other hold that lapses.
4. **Idempotency:** the hold's Idempotency-Key is `waitlist-offer:<entryId>:<causeEventId>`. A redelivered event
   replays the same hold instead of creating a second one; a new event for the same slot is a new decision.
5. **Entry lifecycle:** `waiting → offered → booked` (accepted) | `expired` (ignored, plus an `offer_expired`
   message) | `cancelled` (declined or left the waitlist). Leaving while an offer is open releases its hold, so
   the slot moves on to the next person.
6. **The HTTP call happens inside the matcher's transaction** (holding the entry's row lock for ~10 ms). If the
   transaction then fails, the hold already exists. The idempotent retry finds it again, and if no retry comes,
   the hold simply expires and the cascade continues.

## Consequences

- Offers are as safe as any booking: the EXCLUDE constraint and the conditional UPDATE apply to them too.
- The cascade speed is bounded by the offer TTL (`OFFER_TTL_SECONDS`, default 600).
