// Read-only queries. Reads may run on any connection; only writes go through the idempotent transaction.
import type { Appointment, Doctor, Patient, PatientAppointment, SlotView } from '@ds/shared';
import type { Pool } from '../db.js';

/** Columns for an Appointment, from `appointments a JOIN slots s ON s.id = a.slot_id`. */
export const APPOINTMENT_COLUMNS = `
  a.id, a.slot_id AS "slotId", a.doctor_id AS "doctorId", a.patient_id AS "patientId",
  a.visit_type AS "visitType", a.status, lower(s.during) AS start, upper(s.during) AS "end",
  a.created_at AS "createdAt"`;

export async function getDoctor(pool: Pool, id: string): Promise<Doctor | undefined> {
  const { rows } = await pool.query<Doctor>(
    `SELECT id, name, specialty, clinic, area, lat, lng, languages, rating::float AS rating, rating_count AS "ratingCount", tz
       FROM doctors WHERE id = $1`,
    [id],
  );
  return rows[0];
}

/**
 * Every base slot on one local calendar day of the doctor. The day boundaries are computed in the doctor's tz
 * and compared as UTC ranges. Effective status: an expired hold counts as 'open', and a base slot covered by a
 * live composite (30-minute) hold or booking takes that composite's status.
 */
export async function slotsForDay(pool: Pool, doctorId: string, date: string): Promise<SlotView[]> {
  const { rows } = await pool.query<SlotView>(
    `SELECT s.id, s.doctor_id AS "doctorId", lower(s.during) AS start, upper(s.during) AS "end",
            CASE
              WHEN s.status = 'held' AND s.hold_expires_at >= now() THEN 'held'
              WHEN s.status IN ('booked', 'blocked') THEN s.status
              WHEN cover.status IS NOT NULL THEN cover.status
              ELSE 'open'
            END AS status,
            s.version,
            to_char(lower(s.during) AT TIME ZONE d.tz, 'HH24:MI') AS "localTime"
       FROM slots s
       JOIN doctors d ON d.id = s.doctor_id
       LEFT JOIN LATERAL (
              SELECT c.status FROM slots c
               WHERE c.doctor_id = s.doctor_id AND c.kind = 'composite' AND c.during && s.during
                 AND (c.status = 'booked' OR (c.status = 'held' AND c.hold_expires_at >= now()))
               ORDER BY c.status = 'booked' DESC
               LIMIT 1) cover ON true
      WHERE s.doctor_id = $1
        AND s.kind = 'base'
        AND s.during && tstzrange($2::date::timestamp AT TIME ZONE d.tz,
                                  ($2::date + 1)::timestamp AT TIME ZONE d.tz)
      ORDER BY lower(s.during)`,
    [doctorId, date],
  );
  return rows;
}

/** A patient's appointments: upcoming first (soonest first), then past (most recent first). */
export async function appointmentsForPatient(pool: Pool, patientId: string): Promise<PatientAppointment[]> {
  const { rows } = await pool.query<PatientAppointment>(
    `SELECT ${APPOINTMENT_COLUMNS},
            d.name AS "doctorName", d.specialty, d.clinic, d.area, d.tz, r.stars AS "myReviewStars"
       FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctors d ON d.id = a.doctor_id
       LEFT JOIN reviews r ON r.appointment_id = a.id
      WHERE a.patient_id = $1
      ORDER BY lower(s.during) < now(), abs(extract(epoch FROM lower(s.during) - now()))
      LIMIT 100`,
    [patientId],
  );
  return rows;
}

export async function getAppointment(pool: Pool, id: string): Promise<Appointment | undefined> {
  const { rows } = await pool.query<Appointment>(
    `SELECT ${APPOINTMENT_COLUMNS} FROM appointments a JOIN slots s ON s.id = a.slot_id WHERE a.id = $1`,
    [id],
  );
  return rows[0];
}

export async function listPatients(pool: Pool, limit: number): Promise<Patient[]> {
  const { rows } = await pool.query<Patient>('SELECT id, name, phone FROM patients ORDER BY name, id LIMIT $1', [limit]);
  return rows;
}
