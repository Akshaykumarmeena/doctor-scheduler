-- Phase 5: the doctor manages their own schedule.

-- Why a slot is blocked: the doctor's working hours no longer cover it, or it falls in time off.
-- Hours changes and time-off removal only ever reopen slots they themselves blocked.
ALTER TABLE slots ADD COLUMN blocked_reason text CHECK (blocked_reason IN ('hours', 'time_off'));
ALTER TABLE slots ADD CONSTRAINT slots_blocked_reason_consistent CHECK ((status = 'blocked') = (blocked_reason IS NOT NULL));

-- Who cancelled, and why (a doctor's time off cancels bookings on the doctor's side).
ALTER TABLE appointments
  ADD COLUMN cancelled_by text CHECK (cancelled_by IN ('patient', 'doctor')),
  ADD COLUMN cancel_reason text;
UPDATE appointments SET cancelled_by = 'patient' WHERE status = 'cancelled';
ALTER TABLE appointments ADD CONSTRAINT appointments_cancelled_by_only_when_cancelled
  CHECK (cancelled_by IS NULL OR status = 'cancelled');

-- Stats and the week view read a doctor's appointments by time.
CREATE INDEX appointments_doctor_during_idx ON appointments USING gist (doctor_id, during);
