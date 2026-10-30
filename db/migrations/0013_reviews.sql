-- Phase 8: reviews and a fair (Bayesian) rating.

-- One review per completed visit. Only the visit's patient may write it (checked by booking-api); no edits.
CREATE TABLE reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  uuid NOT NULL UNIQUE REFERENCES appointments (id),
  doctor_id       uuid NOT NULL REFERENCES doctors (id),
  patient_id      uuid NOT NULL REFERENCES patients (id),
  stars           smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment         text CHECK (char_length(comment) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- "Latest reviews of this doctor".
CREATE INDEX reviews_doctor_created_idx ON reviews (doctor_id, created_at DESC);

-- doctors.rating becomes the FAIR rating: (C * prior + rating_sum) / (C + rating_count), C = 20.
-- rating_prior is the rating the doctor had before their first real review (the seeded one), captured on that
-- first review; NULL until then. A doctor with no rating at all gets the platform mean as the prior.
ALTER TABLE doctors
  ADD COLUMN rating_prior numeric(2,1) CHECK (rating_prior BETWEEN 0 AND 5),
  ADD COLUMN rating_count integer NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  ADD COLUMN rating_sum   integer NOT NULL DEFAULT 0 CHECK (rating_sum >= 0);
