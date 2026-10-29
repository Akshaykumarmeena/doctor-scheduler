-- Phase 4 additions (approved 2026-10-29): closed-tab leases, and one patient can't be in two places at once.

-- 1. Hold lease + deadline. hold_expires_at is now a LEASE that the open booking page renews every 30 s
--    (POST /holds/:id/heartbeat); hold_deadline_at is the hard cap the lease can never pass. Close the tab and
--    the lease lapses within ~2 minutes. NULL deadline (older rows, tests) = "no cap beyond hold_expires_at".
--    Only meaningful while status = 'held'.
ALTER TABLE slots ADD COLUMN hold_deadline_at timestamptz;

-- 2. A patient can't hold two overlapping times, even with different doctors: the same trick as the doctor
--    guard (Phase 1), keyed by patient instead of doctor.
ALTER TABLE slots ADD CONSTRAINT slots_patient_no_overlapping_holds EXCLUDE USING gist (
  hold_patient_id WITH =,
  during          WITH &&
) WHERE (status = 'held');

-- 3. A patient can't have two overlapping confirmed appointments. The appointment needs its own time range for
--    that, so it gets one, copied from its slot when the row is inserted (a trigger, so every writer is covered).
ALTER TABLE appointments ADD COLUMN during tstzrange;
UPDATE appointments a SET during = s.during FROM slots s WHERE s.id = a.slot_id;
ALTER TABLE appointments ALTER COLUMN during SET NOT NULL;

CREATE FUNCTION appointments_copy_slot_during() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT during INTO NEW.during FROM slots WHERE id = NEW.slot_id;
  RETURN NEW;
END $$;

CREATE TRIGGER appointments_copy_slot_during
  BEFORE INSERT ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_copy_slot_during();

ALTER TABLE appointments ADD CONSTRAINT appointments_patient_no_overlap EXCLUDE USING gist (
  patient_id WITH =,
  during     WITH &&
) WHERE (status = 'confirmed');
