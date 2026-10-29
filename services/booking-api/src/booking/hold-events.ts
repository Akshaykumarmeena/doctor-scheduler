// Hold events (Phase 4): every change to a hold is written to the outbox in the same transaction as the change,
// so live updates, the notifier and the waitlist matcher hear about it exactly when it really happened.
import type { Hold } from '@ds/shared';
import type { Tx } from '../idempotency.js';

export type HoldEventType = 'hold.created' | 'hold.released' | 'hold.expired';

/** Same payload shape for every hold event: { holdId, slotId, doctorId, patientId, start, end }. */
const payloadSql = (a: string) =>
  `json_build_object('holdId', ${a}.hold_id, 'slotId', ${a}.id, 'doctorId', ${a}.doctor_id,
                     'patientId', ${a}.hold_patient_id, 'start', lower(${a}.during), 'end', upper(${a}.during))`;

export async function emitHoldCreated(tx: Tx, hold: Hold) {
  await tx.query(
    `INSERT INTO outbox (doctor_id, aggregate_id, event_type, payload) VALUES ($1, $2, 'hold.created', $3)`,
    [hold.doctorId, hold.holdId, JSON.stringify(hold)],
  );
}

/**
 * One statement that releases the held rows matched by `where` back to 'open' AND writes one outbox event per
 * released hold. The CTE reads the hold columns BEFORE they are cleared, so the event knows whose hold it was.
 * `lock` is 'FOR UPDATE' (wait for other writers) or 'FOR UPDATE SKIP LOCKED' (sweeper: skip busy rows).
 */
export function releaseHoldsSql(where: string, eventType: Exclude<HoldEventType, 'hold.created'>, lock: string, limit = '') {
  return `
    WITH gone AS (
      SELECT id, doctor_id, hold_id, hold_patient_id, during
        FROM slots
       WHERE ${where}
       ${limit}
       ${lock}
    ), released AS (
      UPDATE slots s
         SET status = 'open', hold_id = NULL, hold_patient_id = NULL, hold_expires_at = NULL,
             hold_deadline_at = NULL, version = s.version + 1, updated_at = now()
        FROM gone
       WHERE s.id = gone.id
      RETURNING gone.id, gone.doctor_id, gone.hold_id, gone.hold_patient_id, gone.during
    ), events AS (
      INSERT INTO outbox (doctor_id, aggregate_id, event_type, payload)
      SELECT doctor_id, hold_id, '${eventType}', ${payloadSql('released')} FROM released
    )
    SELECT id AS "slotId", hold_id AS "holdId" FROM released`;
}
