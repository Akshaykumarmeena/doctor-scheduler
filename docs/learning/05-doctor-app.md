# Phase 5 – The doctor app: hours, time off, and numbers

Patients have had their screens since Phase 3. Now the other side of the marketplace: a doctor sees their week,
changes their hours, takes time off, and sees how full their schedule is. The interesting part isn't the screens.
It's **changing the supply while people are booking it**.

## 1. Schedule = rules + materialized slots

- **Rules** (`schedule_templates`): "Mon 09:00–13:00", in the doctor's local time, with `valid_from` / `valid_to`.
- **Slots**: concrete UTC rows for the next 14 days, made by the materializer (Phase 1).

Changing hours means changing the rules AND fixing the already-materialized slots, in one transaction:
new hours → new open slots · removed hours → open slots become `blocked` (reason `hours`) · hours restored →
those blocked slots reopen. Changes start **tomorrow**: today's slots are already promised.

Why keep old rules (`valid_to = today`) instead of deleting them? History. Last month's utilization should be
measured against last month's hours.

## 2. The hard question: what about people who already booked?

| Change | Our policy (Akshay's decisions) | Why |
| --- | --- | --- |
| Hours removed over a booking | **Keep** the booking, flag it "outside hours" (1a) | never silently drop a patient; the doctor decides |
| Time off over a booking | Show a **preview**, then **cancel + notify** each patient (2a) | the doctor can't be there; tell patients now, not at the door |
| Time off over a live hold | **Release** the hold | otherwise it could still be confirmed into the time off |

Interviewers love this question because "just update the table" is wrong. The right answer names the policy,
who is told, and how it stays atomic.

## 3. The time-off transaction (Akshay's piece, mode C)

```
lock doctor row (FOR NO KEY UPDATE)       → one schedule change per doctor at a time
insert schedule_exception                 → the materializer will never create slots there again
lock every slot row in the range          → patients' holds/confirms on them wait for us, or already finished
release holds in range        → hold.released
cancel bookings in range      → appointment.cancelled (cancelledBy: doctor) → notifier: "Dr. X is unavailable"
block open slots in range     → blocked_reason = time_off
emit schedule.changed         → search re-indexes, open pages refresh
COMMIT
```

All or nothing: if anything fails, no patient is cancelled and nothing is blocked.

### The race we found while designing it

A 30-minute hold *inserts a new composite row*. Row locks only protect rows that already exist, so time off
couldn't see or block a composite hold being created at the same moment. Fix: the 30-minute hold locks the base
rows it checks (`FOR SHARE`). Now hold and time off always queue behind each other. The test runs them
concurrently 8 times and checks that no hold or booking ever sits inside time off.

General lesson: **row locks don't cover rows that don't exist yet.** Either lock something that does exist (here:
the base slots, or the doctor row), or rely on a constraint (like our EXCLUDE) that sees inserts too.

## 4. Numbers that mean something

Definitions live in code (`doctor/stats.ts`) and on the page:
- **Utilization** = booked minutes / offered minutes. Offered = slots not blocked; booked = confirmed + completed +
  no-show (a 30-minute visit counts 30).
- **Cancellation rate** = cancelled / all appointments in range.
- **No-show rate** = no-shows / visits with an outcome (completed + no-show). That's why the doctor gets
  Done / No-show buttons once a visit has started (decision 3).
- **Lead time** = average time from booking to visit, a demand signal.

In an interview, always define the denominator. "Utilization 80%" means nothing until you say of what.

## 5. Break it

- Two windows: the doctor's week (/doctor/week) and the patient's slot grid for the same doctor. Add time off over
  a booked hour: the patient's grid greys it out, the patient's inbox says the doctor is unavailable, and the
  week shows it closed. All within a second or two.
- Shrink hours over a booking: the booking stays, flagged "outside hours".
- Search for the doctor "free on" that day before and after the time off: search follows (via `schedule.changed`).

## 6. Interview lines

- "Supply changes are transactions too: rules, materialized slots, affected bookings and the event change together."
- "Policy for existing bookings is explicit: keep and flag on hours changes, preview then cancel and notify on time off."
- "Row locks don't protect rows that don't exist yet. Lock an existing parent row or rely on a constraint."
- "Every metric gets a written denominator."
