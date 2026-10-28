-- A recurring weekly rule, written in the doctor's local time ("Mon 09:00-13:00, 15 min").
-- The materializer turns these into concrete UTC slot rows.
CREATE TABLE schedule_templates (
  id            bigserial PRIMARY KEY,
  doctor_id     uuid NOT NULL REFERENCES doctors (id) ON DELETE CASCADE,
  weekday       smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- ISO: 1 = Monday
  start_local   time NOT NULL,
  end_local     time NOT NULL,
  slot_minutes  smallint NOT NULL CHECK (slot_minutes > 0),
  valid_from    date NOT NULL DEFAULT current_date,
  valid_to      date,                                              -- NULL = open-ended
  CHECK (end_local > start_local),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX schedule_templates_doctor_idx ON schedule_templates (doctor_id);

-- One-off time the doctor is unavailable (leave, holiday, conference), as an absolute UTC range.
CREATE TABLE schedule_exceptions (
  id         bigserial PRIMARY KEY,
  doctor_id  uuid NOT NULL REFERENCES doctors (id) ON DELETE CASCADE,
  during     tstzrange NOT NULL CHECK (NOT isempty(during)),
  kind       text NOT NULL CHECK (kind IN ('leave', 'holiday', 'blocked')),
  reason     text
);

-- "Does any exception for this doctor overlap this slot?" -> doctor_id = $1 AND during && $2
CREATE INDEX schedule_exceptions_doctor_during_idx ON schedule_exceptions USING gist (doctor_id, during);
