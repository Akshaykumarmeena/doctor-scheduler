-- A patient waiting for any slot with a doctor inside a time window.
CREATE TABLE waitlist_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id       uuid NOT NULL REFERENCES doctors (id) ON DELETE CASCADE,
  patient_id      uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  desired_window  tstzrange NOT NULL CHECK (NOT isempty(desired_window)),
  status          text NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting', 'offered', 'booked', 'expired', 'cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- "Slot freed up: who is waiting for this doctor at this time?" (FIFO by created_at).
CREATE INDEX waitlist_waiting_idx ON waitlist_entries USING gist (doctor_id, desired_window)
  WHERE status = 'waiting';
