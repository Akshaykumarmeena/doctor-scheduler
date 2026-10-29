# 0007 – Hold leases (closed tab) and "one patient, one place at a time"

Status: accepted (Phase 4, 2026-10-29; both requested by Akshay)

## Context

1. A patient who closes the tab mid-booking kept the slot for the full 5 minutes.
2. Nothing stopped one patient from holding or booking 11:00 with three doctors at once, or hoarding holds.
   The double-booking guarantees were per doctor only.

## Decisions

**Leases.** A hold now has two times: `hold_expires_at` is a **lease** (2 minutes from the booking page), and
`hold_deadline_at` is a hard **cap** (5 minutes). The open page calls `POST /holds/:id/heartbeat` every 30 s,
which sets `expires = min(now + lease, deadline)`. Close the tab → no heartbeats → the hold lapses within 2 minutes →
the sweeper frees it (+ ≤10 s) → live updates and the waitlist react. Reopen within the lease → `GET
/patients/:id/holds` lets the page resume it. Without `leaseSeconds` (e.g. waitlist offers, where the patient
isn't on the page) lease = TTL, so nothing changes for them. Heartbeats emit no event: nothing others see changed.
*Rejected for now:* releasing on tab close with `sendBeacon` (instant, but unreliable on crashes and mobile).
It can be added on top.

**Per-patient overlap**, enforced by the database the same way as per-doctor overlap:
- `slots`: `EXCLUDE (hold_patient_id WITH =, during WITH &&) WHERE status = 'held'`, so no overlapping holds.
- `appointments.during` (copied from the slot by a BEFORE INSERT trigger, so every writer is covered) and
  `EXCLUDE (patient_id WITH =, during WITH &&) WHERE status = 'confirmed'`, so no overlapping appointments.
- `createHold` also checks confirmed appointments up front (a friendly 409 `patient_busy` before anything is
  held), caps live holds at 3 per patient (409 `too_many_holds`), and locks the patient row
  (`FOR NO KEY UPDATE`) so that cap can't be raced.

## Consequences

- The booking page makes one small request every 30 s while a hold is open.
- **Sharding caveat (interview point):** these per-patient constraints work because there is one database. Once
  slots and appointments are sharded **by doctor**, a patient's rows live on different shards and no single
  constraint can see them all. The guarantee then has to move to something keyed by patient: a patient-schedule
  table sharded by `patient_id`, checked in the confirm flow (a saga with compensation), or a per-patient lock.
