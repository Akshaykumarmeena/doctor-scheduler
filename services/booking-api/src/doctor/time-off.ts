// Time off. addTimeOff() is Phase 5's critical piece: Akshay chose mode C (Claude writes it and walks through it,
// and Akshay answers review questions before it is committed).
//
// Decision 2a (Akshay): bookings inside the time off are CANCELLED and each patient is notified, after the doctor
// has seen a preview of exactly which ones.
import type { AffectedAppointment, Appointment, TimeOff, TimeOffKind } from '@ds/shared';
import type { Pool } from '../db.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import type { Tx } from '../idempotency.js';
import { APPOINTMENT_COLUMNS } from '../booking/queries.js';
import { releaseHoldsSql } from '../booking/hold-events.js';
import { materializeSlots } from '../materializer.js';
import { coveredByHoursSql, inTimeOffSql } from './hours-sql.js';

export interface TimeOffInput {
  doctorId: string;
  /** Doctor-local date-times, "2026-11-06T09:00". */
  start: string;
  end: string;
  kind: TimeOffKind;
  reason?: string;
}

/** The doctor's local range as a UTC tstzrange expression ($2, $3 = local start/end; d = doctors row). */
const RANGE_SQL = `tstzrange($2::timestamp AT TIME ZONE d.tz, $3::timestamp AT TIME ZONE d.tz)`;

/** What adding this time off would cancel, so the UI can show it BEFORE the doctor confirms. */
export async function previewTimeOff(pool: Pool, doctorId: string, start: string, end: string): Promise<AffectedAppointment[]> {
  const { rows } = await pool.query<AffectedAppointment>(
    `SELECT a.id, p.name AS "patientName", lower(a.during) AS start, upper(a.during) AS "end"
       FROM doctors d
       JOIN appointments a ON a.doctor_id = d.id AND a.status = 'confirmed' AND a.during && ${RANGE_SQL}
       JOIN patients p ON p.id = a.patient_id
      WHERE d.id = $1
      ORDER BY lower(a.during)`,
    [doctorId, start, end],
  );
  return rows;
}

export interface TimeOffResult {
  timeOff: TimeOff;
  cancelledAppointments: AffectedAppointment[];
  blockedSlots: number;
  releasedHolds: number;
}

export async function addTimeOff(tx: Tx, input: TimeOffInput): Promise<TimeOffResult> {
  // 1. Serialize schedule changes for this doctor (hours changes take the same lock). NO KEY UPDATE: it doesn't
  //    block patients inserting appointments (their FK takes a KEY SHARE lock on the doctor row).
  const doctor = await tx.query<{ valid: boolean; future: boolean }>(
    `SELECT upper(${RANGE_SQL}) > lower(${RANGE_SQL}) AS valid, upper(${RANGE_SQL}) > now() AS future
       FROM doctors d WHERE d.id = $1 FOR NO KEY UPDATE`,
    [input.doctorId, input.start, input.end],
  );
  if (!doctor.rows[0]) throw notFound('doctor_not_found', 'No such doctor');
  if (!doctor.rows[0].valid) throw unprocessable('bad_range', 'End must be after start');
  if (!doctor.rows[0].future) throw unprocessable('in_the_past', 'That time is already over');

  // 2. Record the time off. From now on the materializer will never create slots inside it.
  const created = await tx.query<TimeOff>(
    `INSERT INTO schedule_exceptions (doctor_id, during, kind, reason)
     SELECT d.id, ${RANGE_SQL}, $4, $5 FROM doctors d WHERE d.id = $1
     RETURNING id::text, lower(during) AS start, upper(during) AS "end", kind, reason`,
    [input.doctorId, input.start, input.end, input.kind, input.reason ?? null],
  );
  const timeOff = created.rows[0];
  const range = [timeOff.start, timeOff.end];

  // 3. Lock every slot row of this doctor in the range. A patient's hold or confirm on one of them either
  //    finished before this (we see its result) or waits for our COMMIT (and then sees 'blocked').
  await tx.query(
    `SELECT id FROM slots WHERE doctor_id = $1 AND during && tstzrange($2, $3) FOR UPDATE`,
    [input.doctorId, ...range],
  );

  // 4. Holds in the range are released (hold.released events), so nobody can confirm into the time off.
  const released = await tx.query(
    releaseHoldsSql(`doctor_id = $1 AND during && tstzrange($2, $3) AND status = 'held'`, 'hold.released', 'FOR UPDATE'),
    [input.doctorId, ...range],
  );

  // 5. Bookings in the range are cancelled BY THE DOCTOR (decision 2a): appointment -> cancelled, its slot freed
  //    (step 6 then blocks it), and one appointment.cancelled event each, so the notifier tells the patient.
  const cancelled = await tx.query<{ id: string; slot_id: string }>(
    `UPDATE appointments
        SET status = 'cancelled', cancelled_by = 'doctor', cancel_reason = $4, updated_at = now()
      WHERE doctor_id = $1 AND status = 'confirmed' AND during && tstzrange($2, $3)
      RETURNING id, slot_id`,
    [input.doctorId, ...range, input.reason ?? 'Doctor unavailable'],
  );
  const cancelledIds = cancelled.rows.map((r) => r.id);
  if (cancelledIds.length > 0) {
    await tx.query(
      `UPDATE slots SET status = 'open', appointment_id = NULL, version = version + 1, updated_at = now()
        WHERE id = ANY ($1::uuid[]) AND status = 'booked'`,
      [cancelled.rows.map((r) => r.slot_id)],
    );
    const appts = await tx.query<Appointment & { patientName: string }>(
      `SELECT ${APPOINTMENT_COLUMNS}, p.name AS "patientName"
         FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN patients p ON p.id = a.patient_id
        WHERE a.id = ANY ($1::uuid[])`,
      [cancelledIds],
    );
    await tx.query(
      `INSERT INTO outbox (doctor_id, aggregate_id, event_type, payload)
       SELECT $1, (x->>'id')::uuid, 'appointment.cancelled', x || jsonb_build_object('cancelledBy', 'doctor', 'reason', $3::text)
         FROM jsonb_array_elements($2::jsonb) x`,
      [input.doctorId, JSON.stringify(appts.rows), input.reason ?? 'Doctor unavailable'],
    );
  }

  // 6. Every open base slot in the range is blocked (reason time_off; removing the time off reopens exactly these).
  const blocked = await tx.query(
    `UPDATE slots SET status = 'blocked', blocked_reason = 'time_off', version = version + 1, updated_at = now()
      WHERE doctor_id = $1 AND kind = 'base' AND status = 'open' AND during && tstzrange($2, $3)`,
    [input.doctorId, ...range],
  );

  const result: TimeOffResult = {
    timeOff,
    cancelledAppointments: (
      await tx.query<AffectedAppointment>(
        `SELECT a.id, p.name AS "patientName", lower(a.during) AS start, upper(a.during) AS "end"
           FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ANY ($1::uuid[]) ORDER BY lower(a.during)`,
        [cancelledIds],
      )
    ).rows,
    blockedSlots: blocked.rowCount ?? 0,
    releasedHolds: released.rowCount ?? 0,
  };

  // 7. One schedule event: search re-indexes the doctor, open pages refresh.
  await tx.query(
    // aggregate = the doctor's schedule (time-off ids are bigints, the outbox aggregate is a uuid)
    `INSERT INTO outbox (doctor_id, aggregate_id, event_type, payload) VALUES ($1, $1, 'schedule.changed', $2)`,
    [
      input.doctorId,
      JSON.stringify({
        doctorId: input.doctorId,
        reason: 'time_off',
        timeOffId: timeOff.id,
        start: timeOff.start,
        end: timeOff.end,
        blockedSlots: result.blockedSlots,
        cancelledAppointments: cancelledIds.length,
      }),
    ],
  );
  return result;
}

export async function listTimeOff(pool: Pool, doctorId: string): Promise<(TimeOff & { affectedAppointments: number })[]> {
  const { rows } = await pool.query<TimeOff & { affectedAppointments: number }>(
    `SELECT e.id::text, lower(e.during) AS start, upper(e.during) AS "end", e.kind, e.reason,
            (SELECT count(*)::int FROM appointments a
              WHERE a.doctor_id = e.doctor_id AND a.cancelled_by = 'doctor' AND a.during && e.during) AS "affectedAppointments"
       FROM schedule_exceptions e
      WHERE e.doctor_id = $1 AND upper(e.during) > now()
      ORDER BY lower(e.during)`,
    [doctorId],
  );
  return rows;
}

/**
 * Removes time off and gives the time back: slots it blocked reopen (if still within working hours and not under
 * another time off), and slots that were never created because of it are materialized. Cancelled bookings stay
 * cancelled; those patients were already told.
 */
export async function removeTimeOff(tx: Tx, doctorId: string, timeOffId: string) {
  await tx.query(`SELECT 1 FROM doctors WHERE id = $1 FOR NO KEY UPDATE`, [doctorId]);
  const removed = await tx.query<{ start: Date; end: Date }>(
    `DELETE FROM schedule_exceptions WHERE id = $1::bigint AND doctor_id = $2 RETURNING lower(during) AS start, upper(during) AS "end"`,
    [timeOffId, doctorId],
  );
  if (!removed.rows[0]) throw notFound('time_off_not_found', 'No such time off');
  const { start, end } = removed.rows[0];
  if (end.getTime() <= Date.now()) throw conflict('in_the_past', 'That time off is already over');

  const reopened = await tx.query(
    `UPDATE slots s SET status = 'open', blocked_reason = NULL, version = s.version + 1, updated_at = now()
       FROM doctors d
      WHERE d.id = s.doctor_id AND s.doctor_id = $1 AND s.blocked_reason = 'time_off' AND s.during && tstzrange($2, $3)
        AND ${coveredByHoursSql('s', 'd')} AND NOT ${inTimeOffSql('s')}`,
    [doctorId, start, end],
  );
  // Slots blocked for time off that are now outside working hours keep a truthful reason.
  await tx.query(
    `UPDATE slots s SET blocked_reason = 'hours'
       FROM doctors d
      WHERE d.id = s.doctor_id AND s.doctor_id = $1 AND s.blocked_reason = 'time_off' AND s.during && tstzrange($2, $3)
        AND NOT ${coveredByHoursSql('s', 'd')} AND NOT ${inTimeOffSql('s')}`,
    [doctorId, start, end],
  );
  const from = new Date(Math.max(start.getTime(), Date.now()));
  const days = Math.min(14, Math.ceil((end.getTime() - from.getTime()) / 86_400_000) + 1);
  const added = await materializeSlots(tx, { doctorIds: [doctorId], from, days });

  await tx.query(
    `INSERT INTO outbox (doctor_id, aggregate_id, event_type, payload) VALUES ($1, $1, 'schedule.changed', $2)`,
    [doctorId, JSON.stringify({ doctorId, reason: 'time_off_removed', timeOffId, start, end })],
  );
  return { removed: true, reopenedSlots: (reopened.rowCount ?? 0) + added };
}
