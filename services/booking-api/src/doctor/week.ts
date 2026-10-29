// The doctor's week: 7 local days, every base slot, with the booking (patient name) on it.
import type { WeekView, WeekSlot } from '@ds/shared';
import type { Pool } from '../db.js';
import { notFound, unprocessable } from '../errors.js';
import { coveredByHoursSql } from './hours-sql.js';

export async function weekView(pool: Pool, doctorId: string, monday: string): Promise<WeekView> {
  const doctor = await pool.query<{ tz: string; isodow: number }>(
    `SELECT tz, extract(isodow FROM $2::date)::int AS isodow FROM doctors WHERE id = $1`,
    [doctorId, monday],
  );
  if (!doctor.rows[0]) throw notFound('doctor_not_found', 'No such doctor');
  if (doctor.rows[0].isodow !== 1) throw unprocessable('start_not_monday', 'start must be a Monday (YYYY-MM-DD)');

  const { rows } = await pool.query<WeekSlot & { date: string }>(
    `SELECT s.id, lower(s.during) AS start, upper(s.during) AS "end",
            to_char(lower(s.during) AT TIME ZONE d.tz, 'YYYY-MM-DD') AS date,
            to_char(lower(s.during) AT TIME ZONE d.tz, 'HH24:MI') AS "localTime",
            CASE
              WHEN s.status = 'held' AND s.hold_expires_at >= now() THEN 'held'
              WHEN s.status IN ('booked', 'blocked') THEN s.status
              WHEN appt.id IS NOT NULL THEN 'booked'   -- under a 30-minute booking
              WHEN EXISTS (SELECT 1 FROM slots c
                            WHERE c.doctor_id = s.doctor_id AND c.kind = 'composite' AND c.status = 'held'
                              AND c.hold_expires_at >= now() AND c.during && s.during) THEN 'held'
              ELSE 'open'
            END AS status,
            s.blocked_reason AS "blockedReason",
            CASE WHEN appt.id IS NULL THEN NULL ELSE json_build_object(
              'id', appt.id, 'patientName', appt.patient_name, 'visitType', appt.visit_type,
              'minutes', appt.minutes, 'status', appt.status, 'startsHere', appt.starts_here) END AS appointment,
            (appt.id IS NOT NULL AND NOT ${coveredByHoursSql('s', 'd')}) AS "outsideHours"
       FROM slots s
       JOIN doctors d ON d.id = s.doctor_id
       LEFT JOIN LATERAL (
              SELECT a.id, p.name AS patient_name, a.visit_type, a.status,
                     (extract(epoch FROM upper(a.during) - lower(a.during)) / 60)::int AS minutes,
                     lower(a.during) = lower(s.during) AS starts_here
                FROM appointments a JOIN patients p ON p.id = a.patient_id
               WHERE a.doctor_id = s.doctor_id AND a.during && s.during
                 AND a.status IN ('confirmed', 'completed', 'no_show')
               LIMIT 1) appt ON true
      WHERE s.doctor_id = $1 AND s.kind = 'base'
        AND s.during && tstzrange($2::date::timestamp AT TIME ZONE d.tz, ($2::date + 7)::timestamp AT TIME ZONE d.tz)
      ORDER BY lower(s.during)`,
    [doctorId, monday],
  );

  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(`${monday}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + i);
    const iso = date.toISOString().slice(0, 10);
    return { date: iso, slots: rows.filter((r) => r.date === iso).map(({ date: _date, ...slot }) => slot) };
  });
  return { doctorId, tz: doctor.rows[0].tz, days };
}
