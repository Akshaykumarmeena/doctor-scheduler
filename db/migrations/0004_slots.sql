-- A slot is a concrete, bookable interval of a doctor's time, stored in UTC.
-- The booking API is the only writer of this table.
CREATE TABLE slots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id        uuid NOT NULL REFERENCES doctors (id) ON DELETE CASCADE,
  -- Half-open interval [start, end): 09:00-09:15 and 09:15-09:30 touch but do not overlap.
  during           tstzrange NOT NULL
                   CHECK (NOT isempty(during) AND lower_inc(during) AND NOT upper_inc(during)),
  status           text NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'held', 'booked', 'blocked')),
  hold_id          uuid,
  hold_expires_at  timestamptz,
  appointment_id   uuid,
  -- Optimistic-concurrency counter; every write does version = version + 1.
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- A held slot must say who holds it and until when.
  CONSTRAINT slots_hold_consistent CHECK (
    (status = 'held') = (hold_id IS NOT NULL AND hold_expires_at IS NOT NULL)
  ),
  -- A booked slot must point at its appointment.
  CONSTRAINT slots_booked_has_appointment CHECK (
    status <> 'booked' OR appointment_id IS NOT NULL
  ),

  -- Same doctor + same exact interval = same slot. Makes the materializer idempotent
  -- (INSERT ... ON CONFLICT (doctor_id, during) DO NOTHING).
  CONSTRAINT slots_doctor_during_key UNIQUE (doctor_id, during),

  -- THE double-booking guard. For one doctor, no two held/booked rows may overlap
  -- in time (&&), whatever their start times or lengths. Open/blocked rows are ignored.
  CONSTRAINT slots_no_overlapping_commitments EXCLUDE USING gist (
    doctor_id WITH =,
    during    WITH &&
  ) WHERE (status IN ('held', 'booked'))
);

-- Availability for one doctor over a window: doctor_id = $1 AND during && $2
CREATE INDEX slots_doctor_during_gist_idx ON slots USING gist (doctor_id, during);
-- "Next open slot from now" across doctors.
CREATE INDEX slots_open_start_idx ON slots (lower(during)) WHERE status = 'open';
-- The hold-expiry sweeper scans only live holds.
CREATE INDEX slots_hold_expiry_idx ON slots (hold_expires_at) WHERE status = 'held';
