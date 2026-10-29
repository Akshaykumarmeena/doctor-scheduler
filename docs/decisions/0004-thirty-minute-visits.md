# 0004 – 30-minute visits as a composite slot row ("merge row")

Status: accepted (Phase 3, 2026-10-29; Option 1 chosen by Akshay)

## Context

Slots are materialized in 15-minute base rows. Some visits need 30 minutes, which means two consecutive base
slots, taken atomically, never overlapping anyone else's hold or booking.

## Options

1. **Merge row (chosen).** Holding 09:00–09:30 inserts ONE `kind = 'composite'` slot row covering both base rows,
   status `held`. The Phase 1 EXCLUDE constraint `(doctor_id WITH =, during WITH &&) WHERE status IN ('held','booked')`
   then makes a live composite row and any live base row mutually exclusive, in both directions, under any concurrency.
2. **Multi-row hold.** Mark both base rows held under one `hold_id`, in one UPDATE that must touch exactly 2 rows.
   Common in practice, but EXCLUDE plays no part, `hold_id` stops being unique, and an appointment spans two rows.

## Decision details

- Schema 0009: `slots.kind ('base' | 'composite')` + a partial GiST index on live composite rows.
- `createHold(durationMinutes = 30)`: check that consecutive OPEN base rows cover exactly the 30 minutes
  (no break or leave in the middle), then `INSERT ... ON CONFLICT (doctor_id, during) DO UPDATE ... WHERE open`,
  which reuses a previously released composite row for the same range. EXCLUDE violations (23P01) become 409.
- **Expired holds:** EXCLUDE counts every `held` row, expired or not. So before any hold, expired holds that overlap
  the requested time are released inline. "An expired hold is free" stays true without waiting for the sweeper.
- Confirm, cancel, release and the sweeper work unchanged on composite rows; they only see a slot row.
- The slot grid shows base rows only; a base row covered by a live composite hold/booking takes its status.
- Search availability ignores holds and subtracts base rows covered by a booked composite.

## Consequences

- Composite rows stay in the table after cancel/expiry as `open`, and are reused.
- Longer visits (45/60 min) are the same code with a different `durationMinutes`.
