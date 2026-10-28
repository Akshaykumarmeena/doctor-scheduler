CREATE TABLE appointments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id          uuid NOT NULL REFERENCES slots (id),
  doctor_id        uuid NOT NULL REFERENCES doctors (id),
  patient_id       uuid NOT NULL REFERENCES patients (id),
  visit_type       text NOT NULL CHECK (visit_type IN ('in_person', 'video')),
  status           text NOT NULL DEFAULT 'confirmed'
                   CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
  -- Client-supplied key; a retried POST with the same key returns the same appointment.
  idempotency_key  text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- At most one live appointment per slot (cancelled ones are history).
CREATE UNIQUE INDEX appointments_one_live_per_slot ON appointments (slot_id) WHERE status <> 'cancelled';
CREATE INDEX appointments_patient_idx ON appointments (patient_id, created_at DESC);
CREATE INDEX appointments_doctor_idx ON appointments (doctor_id, created_at DESC);

-- slots.appointment_id -> appointments.id. Deferred so a slot and its appointment
-- can be written in either order inside one transaction.
ALTER TABLE slots
  ADD CONSTRAINT slots_appointment_fk FOREIGN KEY (appointment_id)
  REFERENCES appointments (id) DEFERRABLE INITIALLY DEFERRED;
