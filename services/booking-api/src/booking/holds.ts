import type { Hold } from '@ds/shared';
import { conflict, notFound, unprocessable } from '../errors.js';
import type { Tx } from '../idempotency.js';

export const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS ?? 300);

/**
 * Takes a 5-minute hold on an open slot. The whole decision is ONE conditional UPDATE:
 * the WHERE clause is the "is it still free?" check, and Postgres's row lock makes it atomic.
 * Under READ COMMITTED, a concurrent UPDATE on the same row waits for the winner to commit and then
 * re-checks the WHERE against the new row, which no longer matches, so it updates 0 rows.
 * An expired hold counts as free, so correctness never depends on the sweeper having run.
 */
export async function createHold(tx: Tx, input: { slotId: string; patientId: string }): Promise<Hold> {
  const { rows } = await tx.query<Hold>(
    `UPDATE slots
        SET status = 'held',
            hold_id = gen_random_uuid(),
            hold_patient_id = $2,
            hold_expires_at = now() + make_interval(secs => $3),
            version = version + 1,
            updated_at = now()
      WHERE id = $1
        AND (status = 'open' OR (status = 'held' AND hold_expires_at < now()))
        AND lower(during) > now()
      RETURNING hold_id AS "holdId", id AS "slotId", doctor_id AS "doctorId",
                hold_patient_id AS "patientId", hold_expires_at AS "expiresAt"`,
    [input.slotId, input.patientId, HOLD_TTL_SECONDS],
  ).catch((err: { code?: string }) => {
    if (err.code === '23503') throw unprocessable('patient_not_found', 'No such patient'); // FK violation
    throw err;
  });
  if (rows[0]) return rows[0];

  const exists = await tx.query('SELECT 1 FROM slots WHERE id = $1', [input.slotId]);
  if (exists.rowCount === 0) throw notFound('slot_not_found', 'No such slot');
  throw conflict('slot_unavailable', 'Slot is already held, booked, blocked or in the past');
}

/** Releases a live hold early. Releasing an unknown or already-expired hold is a 404. */
export async function releaseHold(tx: Tx, holdId: string): Promise<{ released: true; slotId: string }> {
  const { rows } = await tx.query<{ slotId: string }>(
    `UPDATE slots
        SET status = 'open', hold_id = NULL, hold_patient_id = NULL, hold_expires_at = NULL,
            version = version + 1, updated_at = now()
      WHERE hold_id = $1 AND status = 'held' AND hold_expires_at >= now()
      RETURNING id AS "slotId"`,
    [holdId],
  );
  if (!rows[0]) throw notFound('hold_not_found', 'No live hold with this id');
  return { released: true, slotId: rows[0].slotId };
}
