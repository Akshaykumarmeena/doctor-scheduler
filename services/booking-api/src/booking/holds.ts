import type { Hold } from '@ds/shared';
import { conflict, notFound, unprocessable } from '../errors.js';
import type { Tx } from '../idempotency.js';

export const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS ?? 300);
export const VISIT_MINUTES = [15, 30] as const;
export type VisitMinutes = (typeof VISIT_MINUTES)[number];

const HOLD_COLUMNS = `hold_id AS "holdId", id AS "slotId", doctor_id AS "doctorId",
  hold_patient_id AS "patientId", hold_expires_at AS "expiresAt",
  lower(during) AS start, upper(during) AS "end"`;

/** Postgres errors that mean "someone else has this time", turned into a 409/422 for the client. */
function mapWriteError(err: { code?: string; constraint?: string }): never {
  if (err.code === '23P01') throw conflict('slot_unavailable', 'That time overlaps a hold or booking'); // EXCLUDE
  if (err.code === '23503' && err.constraint === 'slots_hold_patient_id_fkey') {
    throw unprocessable('patient_not_found', 'No such patient');
  }
  throw err;
}

/**
 * Takes a 5-minute hold starting at a base slot, for 15 or 30 minutes.
 *
 * 15 min: one conditional UPDATE on the base row (Phase 2). The WHERE clause is the availability check;
 *         Postgres's row lock serializes racers.
 * 30 min: INSERT (or reuse) one composite row spanning two consecutive base rows, as 'held'. The EXCLUDE
 *         constraint rejects it if any held/booked row of this doctor overlaps, base or composite.
 *
 * Either way, expired holds overlapping the requested time are released first. EXCLUDE counts every
 * 'held' row, expired or not, so this keeps "an expired hold is free" true without waiting for the sweeper.
 */
export async function createHold(
  tx: Tx,
  input: { slotId: string; patientId: string; durationMinutes?: VisitMinutes },
): Promise<Hold> {
  const minutes = input.durationMinutes ?? 15;

  const base = await tx.query<{ doctor_id: string; start: Date; minutes: number }>(
    `SELECT doctor_id, lower(during) AS start, extract(epoch FROM upper(during) - lower(during))::int / 60 AS minutes
       FROM slots WHERE id = $1 AND kind = 'base'`,
    [input.slotId],
  );
  if (!base.rows[0]) throw notFound('slot_not_found', 'No such slot');
  const { doctor_id: doctorId, start } = base.rows[0];
  if (start.getTime() <= Date.now()) throw conflict('slot_unavailable', 'That slot is in the past');

  await releaseExpiredOverlapping(tx, doctorId, start, minutes);

  try {
    if (minutes === base.rows[0].minutes) return await holdBaseSlot(tx, input.slotId, input.patientId);
    return await holdComposite(tx, doctorId, start, minutes, input.patientId);
  } catch (err) {
    return mapWriteError(err as { code?: string });
  }
}

async function releaseExpiredOverlapping(tx: Tx, doctorId: string, start: Date, minutes: number) {
  await tx.query(
    `UPDATE slots
        SET status = 'open', hold_id = NULL, hold_patient_id = NULL, hold_expires_at = NULL,
            version = version + 1, updated_at = now()
      WHERE doctor_id = $1
        AND during && tstzrange($2::timestamptz, $2::timestamptz + make_interval(mins => $3::int))
        AND status = 'held' AND hold_expires_at < now()`,
    [doctorId, start, minutes],
  );
}

async function holdBaseSlot(tx: Tx, slotId: string, patientId: string): Promise<Hold> {
  const { rows } = await tx.query<Hold>(
    `UPDATE slots
        SET status = 'held',
            hold_id = gen_random_uuid(),
            hold_patient_id = $2,
            hold_expires_at = now() + make_interval(secs => $3::int),
            version = version + 1,
            updated_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING ${HOLD_COLUMNS}`,
    [slotId, patientId, HOLD_TTL_SECONDS],
  );
  if (!rows[0]) throw conflict('slot_unavailable', 'Slot is already held, booked or blocked');
  return rows[0];
}

async function holdComposite(tx: Tx, doctorId: string, start: Date, minutes: number, patientId: string): Promise<Hold> {
  // The doctor must actually work the whole span: consecutive OPEN base rows covering it exactly
  // (no lunch break, leave day or blocked slot in the middle).
  const cover = await tx.query<{ covered: number; all_open: boolean }>(
    `SELECT coalesce(sum(extract(epoch FROM upper(during) - lower(during)))::int / 60, 0) AS covered,
            coalesce(bool_and(status = 'open'), false) AS all_open
       FROM slots
      WHERE doctor_id = $1 AND kind = 'base'
        AND during <@ tstzrange($2::timestamptz, $2::timestamptz + make_interval(mins => $3::int))`,
    [doctorId, start, minutes],
  );
  if (cover.rows[0].covered !== minutes) {
    throw conflict('slot_unavailable', `The doctor is not available for ${minutes} minutes from that time`);
  }
  if (!cover.rows[0].all_open) throw conflict('slot_unavailable', 'Part of that time is already held or booked');

  // Insert the composite row as 'held', or reuse an existing OPEN one with the same range
  // (UNIQUE (doctor_id, during)). A held/booked one stays untouched -> 0 rows -> 409.
  const { rows } = await tx.query<Hold>(
    `INSERT INTO slots (doctor_id, during, kind, status, hold_id, hold_patient_id, hold_expires_at)
     VALUES ($1, tstzrange($2::timestamptz, $2::timestamptz + make_interval(mins => $3::int)), 'composite', 'held',
             gen_random_uuid(), $4, now() + make_interval(secs => $5::int))
     ON CONFLICT (doctor_id, during) DO UPDATE
        SET status = 'held', hold_id = EXCLUDED.hold_id, hold_patient_id = EXCLUDED.hold_patient_id,
            hold_expires_at = EXCLUDED.hold_expires_at, version = slots.version + 1, updated_at = now()
      WHERE slots.status = 'open' AND slots.kind = 'composite'
     RETURNING ${HOLD_COLUMNS}`,
    [doctorId, start, minutes, patientId, HOLD_TTL_SECONDS],
  );
  if (!rows[0]) throw conflict('slot_unavailable', 'That time is already held or booked');
  return rows[0];
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
