// Expands each doctor's weekly schedule_templates into concrete UTC slot rows for the next N days,
// skipping any slot that overlaps a schedule_exception. Idempotent: re-running inserts nothing new,
// because UNIQUE (doctor_id, during) + ON CONFLICT DO NOTHING drops slots that already exist.
//
// Not handled yet (later phase): removing/blocking OPEN slots when an exception is added after
// the slots were materialized.
import type { Pool } from './db.js';

export interface MaterializeOptions {
  /** How many local calendar days to cover, starting with "today" in each doctor's tz. */
  days?: number;
  /** Reference instant; slots starting before it are not created. Defaults to now(). */
  from?: Date;
  /** Limit to these doctors (default: all). */
  doctorIds?: string[];
}

const MATERIALIZE_SQL = `
WITH params AS (
  SELECT coalesce($1::timestamptz, now()) AS from_ts, $2::int AS days
),
doctor_days AS (
  -- Every local calendar date in the window, per doctor, in the doctor's own time zone.
  SELECT d.id AS doctor_id, d.tz, gs::date AS local_date
    FROM doctors d, params p,
         -- ::timestamp keeps this independent of the session TimeZone setting.
         generate_series((p.from_ts AT TIME ZONE d.tz)::date::timestamp,
                         ((p.from_ts AT TIME ZONE d.tz)::date + (p.days - 1))::timestamp,
                         interval '1 day') AS gs
   WHERE $3::uuid[] IS NULL OR d.id = ANY ($3::uuid[])
),
candidates AS (
  -- local wall-clock start (timestamp without tz) -> AT TIME ZONE tz -> UTC instant (timestamptz)
  SELECT dd.doctor_id,
         tstzrange(s.local_start AT TIME ZONE dd.tz,
                   (s.local_start + make_interval(mins => t.slot_minutes)) AT TIME ZONE dd.tz,
                   '[)') AS during
    FROM doctor_days dd
    JOIN schedule_templates t
      ON t.doctor_id = dd.doctor_id
     AND t.weekday = extract(isodow FROM dd.local_date)
     AND dd.local_date >= t.valid_from
     AND (t.valid_to IS NULL OR dd.local_date <= t.valid_to)
   CROSS JOIN LATERAL generate_series(dd.local_date + t.start_local,
                                      dd.local_date + t.end_local - make_interval(mins => t.slot_minutes),
                                      make_interval(mins => t.slot_minutes)) AS s(local_start)
)
INSERT INTO slots (doctor_id, during)
SELECT c.doctor_id, c.during
  FROM candidates c, params p
 WHERE lower(c.during) >= p.from_ts
   AND NOT EXISTS (
         SELECT 1 FROM schedule_exceptions e
          WHERE e.doctor_id = c.doctor_id AND e.during && c.during)
ON CONFLICT (doctor_id, during) DO NOTHING
`;

/** Returns the number of slot rows newly inserted. */
export async function materializeSlots(pool: Pool, opts: MaterializeOptions = {}): Promise<number> {
  const { days = 14, from, doctorIds } = opts;
  const result = await pool.query(MATERIALIZE_SQL, [from ?? null, days, doctorIds ?? null]);
  return result.rowCount ?? 0;
}
