// After a visit's start time, the doctor records what happened: completed, or the patient didn't show up.
// The slot stays booked either way (the time was used / lost); only the appointment's status changes.
import type { Appointment } from '@ds/shared';
import { conflict, notFound } from '../errors.js';
import type { Tx } from '../idempotency.js';
import { APPOINTMENT_COLUMNS } from '../booking/queries.js';

export async function recordOutcome(tx: Tx, appointmentId: string, outcome: 'completed' | 'no_show'): Promise<Appointment> {
  const { rows } = await tx.query<{ status: string; started: boolean }>(
    `SELECT status, lower(during) <= now() AS started FROM appointments WHERE id = $1 FOR UPDATE`,
    [appointmentId],
  );
  if (!rows[0]) throw notFound('appointment_not_found', 'No such appointment');
  if (rows[0].status !== 'confirmed') throw conflict('appointment_not_confirmed', `Appointment is already ${rows[0].status}`);
  if (!rows[0].started) throw conflict('appointment_not_started', 'An outcome can only be recorded once the visit has started');

  await tx.query(`UPDATE appointments SET status = $2, updated_at = now() WHERE id = $1`, [appointmentId, outcome]);
  const appt = await tx.query<Appointment>(
    `SELECT ${APPOINTMENT_COLUMNS} FROM appointments a JOIN slots s ON s.id = a.slot_id WHERE a.id = $1`,
    [appointmentId],
  );
  return appt.rows[0];
}
