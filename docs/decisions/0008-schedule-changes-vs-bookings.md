# 0008 – Doctor schedule changes vs existing bookings

Status: accepted (Phase 5, 2026-10-29; decisions 1a and 2a by Akshay)

## Context

Doctors change their weekly hours and take time off. Patients may already hold or have booked the affected time.
Every change must keep "no double-booking", never surprise a patient silently, and keep search and open pages
in step.

## Decisions

1. **Working-hours changes apply from tomorrow** (today is already promised). Old rules get `valid_to = today`
   (history kept). In ONE transaction, booking-api replaces the rules, materializes new open slots for 14 days,
   blocks OPEN slots no longer covered (`blocked_reason = 'hours'`), reopens slots it had blocked that are covered
   again, and writes a `schedule.changed` event.
2. **Bookings outside new hours are kept and flagged** (decision 1a). A doctor removing Friday afternoons never
   silently drops a patient; the week view marks those bookings "outside hours", and the change result reports
   how many were kept.
3. **Time off cancels the bookings inside it, after a preview** (decision 2a). `GET …/time-off/preview` lists them;
   `POST …/time-off` then, in one transaction: records the exception, locks every slot row in the range, releases
   holds there (`hold.released`), cancels confirmed appointments (`cancelled_by = 'doctor'`, one
   `appointment.cancelled` each, so the notifier tells each patient "Dr. X is unavailable"), blocks the open slots
   (`blocked_reason = 'time_off'`), and emits `schedule.changed`. Removing time off reopens exactly the slots
   blocked for it (if still inside working hours and not under other time off) and materializes ones never
   created. Cancelled bookings stay cancelled.
4. **One schedule change per doctor at a time**: both hours and time off lock the doctor row `FOR NO KEY UPDATE`
   (which doesn't block patients' appointment inserts, whose foreign key takes only a KEY SHARE lock).
5. **Racing a patient**: time off locks the slot rows in its range, and a 30-minute hold locks (`FOR SHARE`) the
   base rows it checks, so a hold and a time off on the same time always serialize. Either the hold wins and is
   then released, or time off wins and the hold sees `blocked`.
6. **Blocked slots carry a reason** (`hours` | `time_off`), so each mechanism only undoes what it did.
7. **Slots stay 15 minutes** (decision 4); visits of 15 or 30.

## Consequences

- Search and live pages follow schedule changes through the same event pipeline (`schedule.changed` → indexer,
  live-fanout).
- Utilization is defined in `doctor/stats.ts`: offered = non-blocked base minutes, booked = confirmed + completed +
  no-show minutes, no-show rate only over visits with an outcome.
