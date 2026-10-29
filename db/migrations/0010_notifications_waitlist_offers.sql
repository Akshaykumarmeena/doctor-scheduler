-- Phase 4: the patient inbox, and waitlist offers.

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  kind            text NOT NULL
                  CHECK (kind IN ('booked', 'cancelled', 'offer', 'offer_expired', 'reminder_24h', 'reminder_1h')),
  title           text NOT NULL,
  body            text NOT NULL,
  appointment_id  uuid REFERENCES appointments (id),
  hold_id         uuid,
  -- Every writer derives this from what caused the notification (event id, appointment + reminder kind, ...),
  -- so a redelivered Kafka event or a re-run job inserts nothing new: ON CONFLICT (dedupe_key) DO NOTHING.
  dedupe_key      text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz
);

CREATE INDEX notifications_patient_idx ON notifications (patient_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (patient_id) WHERE read_at IS NULL;

-- An offer = the matcher took a (longer) hold on a freed slot for the patient at the head of the line.
ALTER TABLE waitlist_entries
  ADD COLUMN hold_id          uuid,
  ADD COLUMN offered_slot_id  uuid REFERENCES slots (id),
  ADD COLUMN offered_at       timestamptz,
  ADD COLUMN offer_expires_at timestamptz,
  ADD COLUMN updated_at       timestamptz NOT NULL DEFAULT now();

-- First come, first served: the oldest waiting entry per doctor.
CREATE INDEX waitlist_fifo_idx ON waitlist_entries (doctor_id, created_at) WHERE status = 'waiting';
-- Accept/decline/expiry find the entry by its offer hold.
CREATE INDEX waitlist_hold_idx ON waitlist_entries (hold_id) WHERE hold_id IS NOT NULL;
-- A patient can't join the same doctor's waitlist for the same day twice while it is still active.
CREATE UNIQUE INDEX waitlist_one_active ON waitlist_entries (doctor_id, patient_id, desired_window)
  WHERE status IN ('waiting', 'offered');
