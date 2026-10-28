CREATE TABLE doctors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  specialty   text NOT NULL,
  clinic      text NOT NULL,
  area        text NOT NULL,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  languages   text[] NOT NULL DEFAULT '{}',
  rating      numeric(2,1) NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  -- IANA zone the doctor's schedule is written in. Slot times themselves are UTC.
  tz          text NOT NULL DEFAULT 'Asia/Kolkata',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- "Dermatologists in Koramangala" style filters until OpenSearch takes over search.
CREATE INDEX doctors_specialty_area_idx ON doctors (specialty, area);
CREATE INDEX doctors_area_idx ON doctors (area);

CREATE TABLE patients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  phone               text NOT NULL UNIQUE,
  preferred_language  text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
