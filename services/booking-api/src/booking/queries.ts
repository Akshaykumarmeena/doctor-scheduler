// Read-only queries. Reads may run on any connection; only writes go through the idempotent transaction.
import type { Appointment, Doctor, Patient, SlotView } from '@ds/shared';
import type { Pool } from '../db.js';

/** Columns for an Appointment, from `appointments a JOIN slots s ON s.id = a.slot_id`. */
export const APPOINTMENT_COLUMNS = `
  a.id, a.slot_id AS "slotId", a.doctor_id AS "doctorId", a.patient_id AS "patientId",
  a.visit_type AS "visitType", a.status, lower(s.during) AS start, upper(s.during) AS "end",
  a.created_at AS "createdAt"`;

export async function getDoctor(pool: Pool, id: string): Promise<Doctor | undefined> {
  const { rows } = await pool.query<Doctor>(
    'SELECT id, name, specialty, clinic, area, lat, lng, languages, rating, tz FROM doctors WHERE id = $1',
    [id],
  );
  return rows[0];
}

/**
 * Every slot on one local calendar day of the doctor. The day boundaries are computed in the doctor's tz
 * and compared as UTC ranges. An expired hold is reported as 'open' because that is what it effectively is.
 */
export async function slotsForDay(pool: Pool, doctorId: string, date: string): Promise<SlotView[]> {
  const { rows } = await pool.query<SlotView>(
    `SELECT s.id, s.doctor_id AS "doctorId", lower(s.during) AS start, upper(s.during) AS "end",
            CASE WHEN s.status = 'held' AND s.hold_expires_at < now() THEN 'open' ELSE s.status END AS status,
            s.version,
            to_char(lower(s.during) AT TIME ZONE d.tz, 'HH24:MI') AS "localTime"
       FROM slots s
       JOIN doctors d ON d.id = s.doctor_id
      WHERE s.doctor_id = $1
        AND s.during && tstzrange($2::date::timestamp AT TIME ZONE d.tz,
                                  ($2::date + 1)::timestamp AT TIME ZONE d.tz)
      ORDER BY lower(s.during)`,
    [doctorId, date],
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
