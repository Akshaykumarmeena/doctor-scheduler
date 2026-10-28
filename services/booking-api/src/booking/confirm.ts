// The confirm transaction: a live hold becomes a confirmed appointment.
// Phase 2's critical piece. Akshay chose to have Claude write it and walk him through it (option C).
import type { Appointment, VisitType } from '@ds/shared';
import { conflict } from '../errors.js';
import type { Tx } from '../idempotency.js';
import { APPOINTMENT_COLUMNS } from './queries.js';

export interface ConfirmInput {
  holdId: string;
  visitType: VisitType;
  /** The request's Idempotency-Key; stored on the appointment (appointments.idempotency_key is UNIQUE). */
  idempotencyKey: string;
}

/**
 * `tx` is already inside BEGIN (opened by withIdempotency), together with the idempotency key row,
 * so all the writes below and the stored HTTP response commit or roll back as one unit.
 */
export async function confirmHold(tx: Tx, input: ConfirmInput): Promise<Appointment> {
  // 1. Find the live hold and lock its slot row until COMMIT. Nobody else can release, re-hold or
  //    sweep this slot while we work, so the expiry check below stays true for the rest of the transaction.
  const held = await tx.query<{ id: string; doctor_id: string; hold_patient_id: string }>(
    `SELECT id, doctor_id, hold_patient_id
       FROM slots
      WHERE hold_id = $1
        AND status = 'held'
        AND hold_expires_at >= now()
        FOR UPDATE`,
    [input.holdId],
  );
  const slot = held.rows[0];
  if (!slot) throw conflict('hold_expired', 'Hold not found, already used, or expired');

  // 2. The appointment, for the patient who placed the hold (not whoever presents the hold id).
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO appointments (slot_id, doctor_id, patient_id, visit_type, idempotency_key)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [slot.id, slot.doctor_id, slot.hold_patient_id, input.visitType, input.idempotencyKey],
  );
  const appointmentId = inserted.rows[0].id;

  // 3. held -> booked. Clearing the hold columns is required by slots_hold_consistent, and the
  //    EXCLUDE constraint re-checks overlap now that the row is 'booked'.
  await tx.query(
    `UPDATE slots
        SET status = 'booked',
            appointment_id = $2,
            hold_id = NULL, hold_patient_id = NULL, hold_expires_at = NULL,
            version = version + 1,
            updated_at = now()
      WHERE id = $1`,
    [slot.id, appointmentId],
  );

  // 4. Read back the full appointment (with the slot's times) to return and to publish.
  const { rows } = await tx.query<Appointment>(
    `SELECT ${APPOINTMENT_COLUMNS} FROM appointments a JOIN slots s ON s.id = a.slot_id WHERE a.id = $1`,
    [appointmentId],
  );
  const appointment = rows[0];

  // 5. The event, in the same transaction: if the booking commits, the event exists; if not, neither does.
  await tx.query(
    `INSERT INTO outbox (doctor_id, aggregate_id, event_type, payload)
     VALUES ($1, $2, 'appointment.booked', $3)`,
    [appointment.doctorId, appointment.id, JSON.stringify(appointment)],
  );

  return appointment;
}
