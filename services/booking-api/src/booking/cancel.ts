import type { Appointment } from '@ds/shared';
import { conflict, notFound } from '../errors.js';
import type { Tx } from '../idempotency.js';
import { APPOINTMENT_COLUMNS } from './queries.js';

/** Cancels a confirmed appointment, reopens its slot and emits appointment.cancelled, in one transaction. */
export async function cancelAppointment(tx: Tx, appointmentId: string): Promise<Appointment> {
  const cancelled = await tx.query<{ slot_id: string }>(
    `UPDATE appointments SET status = 'cancelled', updated_at = now()
      WHERE id = $1 AND status = 'confirmed'
      RETURNING slot_id`,
    [appointmentId],
  );
  if (!cancelled.rows[0]) {
    const exists = await tx.query('SELECT 1 FROM appointments WHERE id = $1', [appointmentId]);
    if (exists.rowCount === 0) throw notFound('appointment_not_found', 'No such appointment');
    throw conflict('appointment_not_cancellable', 'Only confirmed appointments can be cancelled');
  }

  await tx.query(
    `UPDATE slots
        SET status = 'open', appointment_id = NULL, version = version + 1, updated_at = now()
      WHERE id = $1 AND status = 'booked' AND appointment_id = $2`,
    [cancelled.rows[0].slot_id, appointmentId],
  );

  const { rows } = await tx.query<Appointment>(
    `SELECT ${APPOINTMENT_COLUMNS} FROM appointments a JOIN slots s ON s.id = a.slot_id WHERE a.id = $1`,
    [appointmentId],
  );
  const appointment = rows[0];
  await tx.query(
    `INSERT INTO outbox (doctor_id, aggregate_id, event_type, payload)
     VALUES ($1, $2, 'appointment.cancelled', $3)`,
    [appointment.doctorId, appointment.id, JSON.stringify(appointment)],
  );
  return appointment;
}
