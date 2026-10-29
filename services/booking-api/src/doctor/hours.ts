// Working hours: the doctor's weekly rules (schedule_templates). A change applies from TOMORROW (today's slots
// are already promised to patients) and keeps the old rules as history (valid_to = today).
//
// Decision 1a (Akshay): bookings that fall outside the new hours are KEPT and flagged in the week view; only
// OPEN slots are blocked. booking-api does all of this because it is the only writer of slots (invariant 1).
import type { WorkingHours } from '@ds/shared';
import type { Pool } from '../db.js';
import { notFound, unprocessable } from '../errors.js';
import type { Tx } from '../idempotency.js';
import { materializeSlots } from '../materializer.js';
import { coveredByHoursSql, inTimeOffSql } from './hours-sql.js';

const HHMM = /^([01]\d|2[0-3]):(00|15|30|45)$/;

export async function getWorkingHours(pool: Pool, doctorId: string): Promise<WorkingHours[]> {
  const { rows } = await pool.query<WorkingHours>(
    `SELECT id::text, weekday, to_char(start_local, 'HH24:MI') AS "startLocal", to_char(end_local, 'HH24:MI') AS "endLocal"
       FROM schedule_templates
      WHERE doctor_id = $1
        AND valid_from <= (SELECT (now() AT TIME ZONE tz)::date + 1 FROM doctors WHERE id = $1)
        AND (valid_to IS NULL OR valid_to >= (SELECT (now() AT TIME ZONE tz)::date + 1 FROM doctors WHERE id = $1))
      ORDER BY weekday, start_local`,
    [doctorId],
  );
  return rows;
}

function validate(hours: WorkingHours[]) {
  for (const h of hours) {
    if (!HHMM.test(h.startLocal) || !HHMM.test(h.endLocal)) {
      throw unprocessable('bad_time', `Times must be HH:MM on a 15-minute boundary (got ${h.startLocal}-${h.endLocal})`);
    }
    if (h.endLocal <= h.startLocal) throw unprocessable('bad_range', `End must be after start (${h.startLocal}-${h.endLocal})`);
  }
  const byDay = new Map<number, WorkingHours[]>();
  for (const h of hours) byDay.set(h.weekday, [...(byDay.get(h.weekday) ?? []), h]);
  for (const [day, list] of byDay) {
    const sorted = [...list].sort((a, b) => a.startLocal.localeCompare(b.startLocal));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startLocal < sorted[i - 1].endLocal) throw unprocessable('overlapping_hours', `Hours overlap on weekday ${day}`);
    }
  }
}

export interface HoursChangeResult {
  hours: WorkingHours[];
  addedSlots: number;
  blockedSlots: number;
  reopenedSlots: number;
  keptBookingsOutsideHours: number;
}

export async function replaceWorkingHours(tx: Tx, doctorId: string, hours: WorkingHours[]): Promise<HoursChangeResult> {
  validate(hours);
  // One schedule change per doctor at a time (hours and time off both take this lock).
  const doctor = await tx.query<{ tomorrow: string; from_ts: Date }>(
    `SELECT to_char((now() AT TIME ZONE tz)::date + 1, 'YYYY-MM-DD') AS tomorrow,
            ((now() AT TIME ZONE tz)::date + 1)::timestamp AT TIME ZONE tz AS from_ts
       FROM doctors WHERE id = $1 FOR NO KEY UPDATE`,
    [doctorId],
  );
  if (!doctor.rows[0]) throw notFound('doctor_not_found', 'No such doctor');
  const { tomorrow, from_ts: fromTs } = doctor.rows[0];

  // 1. Rules: end the current ones today (history kept), drop never-used future ones, add the new set.
  await tx.query(`DELETE FROM schedule_templates WHERE doctor_id = $1 AND valid_from >= $2::date`, [doctorId, tomorrow]);
  await tx.query(
    `UPDATE schedule_templates SET valid_to = $2::date - 1 WHERE doctor_id = $1 AND (valid_to IS NULL OR valid_to >= $2::date)`,
    [doctorId, tomorrow],
  );
  for (const h of hours) {
    await tx.query(
      `INSERT INTO schedule_templates (doctor_id, weekday, start_local, end_local, slot_minutes, valid_from)
       VALUES ($1, $2, $3::time, $4::time, 15, $5::date)`,
      [doctorId, h.weekday, h.startLocal, h.endLocal, tomorrow],
    );
  }

  // 2. New hours -> new open slots for the next 14 days (same transaction, so the event below sees them).
  const addedSlots = await materializeSlots(tx, { doctorIds: [doctorId], from: fromTs, days: 14 });

  // 3. Removed hours -> block the OPEN slots there. Held and booked ones are left alone (decision 1a).
  const blocked = await tx.query(
    `UPDATE slots s SET status = 'blocked', blocked_reason = 'hours', version = s.version + 1, updated_at = now()
       FROM doctors d
      WHERE d.id = s.doctor_id AND s.doctor_id = $1 AND s.kind = 'base' AND s.status = 'open'
        AND lower(s.during) >= $2 AND NOT ${coveredByHoursSql('s', 'd')}`,
    [doctorId, fromTs],
  );

  // 4. Hours added back -> reopen slots that THIS mechanism blocked (never ones blocked for time off).
  const reopened = await tx.query(
    `UPDATE slots s SET status = 'open', blocked_reason = NULL, version = s.version + 1, updated_at = now()
       FROM doctors d
      WHERE d.id = s.doctor_id AND s.doctor_id = $1 AND s.kind = 'base' AND s.blocked_reason = 'hours'
        AND lower(s.during) >= $2 AND ${coveredByHoursSql('s', 'd')} AND NOT ${inTimeOffSql('s')}`,
    [doctorId, fromTs],
  );

  const kept = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctors d ON d.id = a.doctor_id
      WHERE a.doctor_id = $1 AND a.status = 'confirmed' AND lower(a.during) >= $2 AND NOT ${coveredByHoursSql('s', 'd')}`,
    [doctorId, fromTs],
  );

  const result: HoursChangeResult = {
    hours: await getWorkingHoursTx(tx, doctorId, tomorrow),
    addedSlots,
    blockedSlots: blocked.rowCount ?? 0,
    reopenedSlots: reopened.rowCount ?? 0,
    keptBookingsOutsideHours: kept.rows[0].n,
  };

  // 5. One event: search re-indexes this doctor and open pages refresh (the existing pipeline).
  await tx.query(
    `INSERT INTO outbox (doctor_id, aggregate_id, event_type, payload) VALUES ($1, $1, 'schedule.changed', $2)`,
    [doctorId, JSON.stringify({ doctorId, reason: 'hours', ...result, hours: undefined })],
  );
  return result;
}

async function getWorkingHoursTx(tx: Tx, doctorId: string, fromDate: string): Promise<WorkingHours[]> {
  const { rows } = await tx.query<WorkingHours>(
    `SELECT id::text, weekday, to_char(start_local, 'HH24:MI') AS "startLocal", to_char(end_local, 'HH24:MI') AS "endLocal"
       FROM schedule_templates WHERE doctor_id = $1 AND valid_from = $2::date ORDER BY weekday, start_local`,
    [doctorId, fromDate],
  );
  return rows;
}
