-- 30-minute visits (ADR 0004, "merge row"): holding 09:00-09:30 inserts ONE composite slot row covering the two
-- 15-minute base rows underneath it. The base rows stay as they are; the slots_no_overlapping_commitments
-- EXCLUDE constraint makes a held/booked composite row and a held/booked base row mutually exclusive.
--
-- base       = materialized from schedule templates; what the slot grid shows
-- composite  = created on demand by a longer hold; reused (same doctor + same range) on later holds
ALTER TABLE slots ADD COLUMN kind text NOT NULL DEFAULT 'base' CHECK (kind IN ('base', 'composite'));

-- "Is any composite commitment covering this base slot?" (slot grid, search availability)
CREATE INDEX slots_composite_live_idx ON slots USING gist (doctor_id, during)
  WHERE kind = 'composite' AND status IN ('held', 'booked');
