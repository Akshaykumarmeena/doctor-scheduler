-- A hold belongs to a patient: confirming it books the appointment for that patient.
ALTER TABLE slots ADD COLUMN hold_patient_id uuid REFERENCES patients (id);

-- Held rows carry all three hold fields; every other status carries none.
ALTER TABLE slots DROP CONSTRAINT slots_hold_consistent;
ALTER TABLE slots ADD CONSTRAINT slots_hold_consistent CHECK (
  (status = 'held'
     AND hold_id IS NOT NULL AND hold_expires_at IS NOT NULL AND hold_patient_id IS NOT NULL)
  OR
  (status <> 'held'
     AND hold_id IS NULL AND hold_expires_at IS NULL AND hold_patient_id IS NULL)
);

-- Confirm and release look a hold up by its id.
CREATE UNIQUE INDEX slots_hold_id_key ON slots (hold_id) WHERE hold_id IS NOT NULL;
