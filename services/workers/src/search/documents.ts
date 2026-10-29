// Builds search documents from Postgres, the source of truth. Both the full reindex and the event-driven
// indexer use this, so a document always reflects the database at the time it was built.
import type pg from 'pg';
import type { DoctorDocument } from './mapping.js';

/**
 * Availability = future base slots that are open or held (holds are too short-lived to index: search says
 * "likely available", booking re-checks) and not covered by a booked 30-minute composite row.
 * Pass doctorIds = null for every doctor.
 */
export async function buildDoctorDocuments(pool: pg.Pool, doctorIds: string[] | null): Promise<DoctorDocument[]> {
  const { rows } = await pool.query<DoctorDocument>(
    `WITH avail AS (
       SELECT s.doctor_id, lower(s.during) AS start
         FROM slots s
        WHERE s.kind = 'base'
          AND lower(s.during) > now()
          AND s.status IN ('open', 'held')
          AND ($1::uuid[] IS NULL OR s.doctor_id = ANY ($1::uuid[]))
          AND NOT EXISTS (
                SELECT 1 FROM slots c
                 WHERE c.doctor_id = s.doctor_id AND c.kind = 'composite'
                   AND c.status = 'booked' AND c.during && s.during)
     )
     SELECT d.id, d.name, d.specialty, d.clinic, d.area, d.languages,
            json_build_object('lat', d.lat, 'lon', d.lng) AS location,
            d.rating::float AS rating, d.tz,
            min(a.start) AS next_available,
            coalesce(array_agg(DISTINCT to_char(a.start AT TIME ZONE d.tz, 'YYYY-MM-DD'))
                       FILTER (WHERE a.start IS NOT NULL), '{}') AS available_dates,
            count(a.start)::int AS open_slots,
            now() AS indexed_at
       FROM doctors d
       LEFT JOIN avail a ON a.doctor_id = d.id
      WHERE $1::uuid[] IS NULL OR d.id = ANY ($1::uuid[])
      GROUP BY d.id`,
    [doctorIds],
  );
  return rows;
}
