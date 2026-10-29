import type { Hold } from '@ds/shared';
import type { Pool } from '../db.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import type { Tx } from '../idempotency.js';
import { emitHoldCreated, releaseHoldsSql } from './hold-events.js';

export const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS ?? 300);
/** Bounds for a caller-chosen TTL (the waitlist matcher uses 600 s for offers). */
export const HOLD_TTL_RANGE = { min: 60, max: 900 } as const;
/** Bounds for a lease (the booking page uses 120 s and renews it every 30 s while the tab is open). */
export const HOLD_LEASE_RANGE = { min: 60, max: 300 } as const;
/** A patient can hold at most this many slots at once (stops one person hoarding a doctor's day). */
export const MAX_LIVE_HOLDS_PER_PATIENT = 3;
export const VISIT_MINUTES = [15, 30] as const;
export type VisitMinutes = (typeof VISIT_MINUTES)[number];

const HOLD_COLUMNS = `hold_id AS "holdId", id AS "slotId", doctor_id AS "doctorId",
  hold_patient_id AS "patientId", hold_expires_at AS "expiresAt",
  coalesce(hold_deadline_at, hold_expires_at) AS "deadlineAt",
  lower(during) AS start, upper(during) AS "end"`;

/** Postgres errors that mean "someone already has this time", turned into a 409/422 for the client. */
function mapWriteError(err: { code?: string; constraint?: string }): never {
  if (err.code === '23P01' && err.constraint === 'slots_patient_no_overlapping_holds') {
    throw conflict('patient_busy', 'You already hold another slot at this time');
  }
  if (err.code === '23P01') throw conflict('slot_unavailable', 'That time overlaps a hold or booking'); // EXCLUDE
  throw err;
}

/**
 * Takes a hold starting at a base slot, for 15 or 30 minutes.
 *
 * 15 min: one conditional UPDATE on the base row (Phase 2). The WHERE clause is the availability check;
 *         Postgres's row lock serializes racers.
 * 30 min: INSERT (or reuse) one composite row spanning two consecutive base rows, as 'held'. The EXCLUDE
 *         constraint rejects it if any held/booked row of this doctor overlaps, base or composite.
 *
 * Timing: the hold lives `leaseSeconds` (renewed by heartbeats, so a closed tab lets it lapse) but never past
 * `ttlSeconds` from now (the deadline). Without a lease, lease = ttl: a fixed hold, as for waitlist offers.
 *
 * Per patient (Phase 4): at most 3 live holds, no overlapping holds (EXCLUDE on hold_patient_id), and no hold
 * over a time they already have a confirmed appointment at.
 *
 * Expired holds overlapping the requested time (of this doctor, or of this patient) are released first.
 * EXCLUDE counts every 'held' row, expired or not, so this keeps "an expired hold is free" true without
 * waiting for the sweeper.
 */
export async function createHold(
  tx: Tx,
  input: { slotId: string; patientId: string; durationMinutes?: VisitMinutes; ttlSeconds?: number; leaseSeconds?: number },
): Promise<Hold> {
  const minutes = input.durationMinutes ?? 15;
  const ttl = input.ttlSeconds ?? HOLD_TTL_SECONDS;
  const lease = Math.min(input.leaseSeconds ?? ttl, ttl);

  const base = await tx.query<{ doctor_id: string; start: Date; minutes: number }>(
    `SELECT doctor_id, lower(during) AS start, extract(epoch FROM upper(during) - lower(during))::int / 60 AS minutes
       FROM slots WHERE id = $1 AND kind = 'base'`,
    [input.slotId],
  );
  if (!base.rows[0]) throw notFound('slot_not_found', 'No such slot');
  const { doctor_id: doctorId, start } = base.rows[0];
  if (start.getTime() <= Date.now()) throw conflict('slot_unavailable', 'That slot is in the past');

  // Lock the patient row: this patient's hold requests run one at a time, so the cap below can't be raced.
  // (NO KEY UPDATE, not UPDATE: it doesn't block the KEY SHARE lock an appointment insert takes via its FK.)
  const patient = await tx.query('SELECT 1 FROM patients WHERE id = $1 FOR NO KEY UPDATE', [input.patientId]);
  if (patient.rowCount === 0) throw unprocessable('patient_not_found', 'No such patient');

  await releaseExpiredOverlapping(tx, doctorId, input.patientId, start, minutes);

  const checks = await tx.query<{ live_holds: number; busy: boolean }>(
    `SELECT (SELECT count(*)::int FROM slots
              WHERE hold_patient_id = $1 AND status = 'held' AND hold_expires_at >= now()) AS live_holds,
            EXISTS (SELECT 1 FROM appointments
                     WHERE patient_id = $1 AND status = 'confirmed'
                       AND during && tstzrange($2::timestamptz, $2::timestamptz + make_interval(mins => $3::int))) AS busy`,
    [input.patientId, start, minutes],
  );
  if (checks.rows[0].busy) throw conflict('patient_busy', 'You already have an appointment at this time');
  if (checks.rows[0].live_holds >= MAX_LIVE_HOLDS_PER_PATIENT) {
    throw conflict('too_many_holds', `You can hold at most ${MAX_LIVE_HOLDS_PER_PATIENT} slots at a time`);
  }

  let hold: Hold;
  try {
    hold =
      minutes === base.rows[0].minutes
        ? await holdBaseSlot(tx, input.slotId, input.patientId, lease, ttl)
        : await holdComposite(tx, doctorId, start, minutes, input.patientId, lease, ttl);
  } catch (err) {
    return mapWriteError(err as { code?: string; constraint?: string });
  }
  await emitHoldCreated(tx, hold);
  return hold;
}

async function releaseExpiredOverlapping(tx: Tx, doctorId: string, patientId: string, start: Date, minutes: number) {
  await tx.query(
    releaseHoldsSql(
      `(doctor_id = $1 OR hold_patient_id = $2)
       AND during && tstzrange($3::timestamptz, $3::timestamptz + make_interval(mins => $4::int))
       AND status = 'held' AND hold_expires_at < now()`,
      'hold.expired',
      'FOR UPDATE',
    ),
    [doctorId, patientId, start, minutes],
  );
}

async function holdBaseSlot(tx: Tx, slotId: string, patientId: string, lease: number, ttl: number): Promise<Hold> {
  const { rows } = await tx.query<Hold>(
    `UPDATE slots
        SET status = 'held',
            hold_id = gen_random_uuid(),
            hold_patient_id = $2,
            hold_expires_at = now() + make_interval(secs => $3::int),
            hold_deadline_at = now() + make_interval(secs => $4::int),
            version = version + 1,
            updated_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING ${HOLD_COLUMNS}`,
    [slotId, patientId, lease, ttl],
  );
  if (!rows[0]) throw conflict('slot_unavailable', 'Slot is already held, booked or blocked');
  return rows[0];
}

async function holdComposite(
  tx: Tx,
  doctorId: string,
  start: Date,
  minutes: number,
  patientId: string,
  lease: number,
  ttl: number,
): Promise<Hold> {
  // Lock the base rows under the span (FOR SHARE: other 30-minute holds may share it, but a writer such as
  // the doctor's time off waits, and we wait for it). Without this, a composite row inserted at the same moment
  // as time off would slip past it: row locks can't protect a row that doesn't exist yet (ADR 0008).
  await tx.query(
    `SELECT id FROM slots
      WHERE doctor_id = $1 AND kind = 'base'
        AND during <@ tstzrange($2::timestamptz, $2::timestamptz + make_interval(mins => $3::int))
      FOR SHARE`,
    [doctorId, start, minutes],
  );
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
    `INSERT INTO slots (doctor_id, during, kind, status, hold_id, hold_patient_id, hold_expires_at, hold_deadline_at)
     VALUES ($1, tstzrange($2::timestamptz, $2::timestamptz + make_interval(mins => $3::int)), 'composite', 'held',
             gen_random_uuid(), $4, now() + make_interval(secs => $5::int), now() + make_interval(secs => $6::int))
     ON CONFLICT (doctor_id, during) DO UPDATE
        SET status = 'held', hold_id = EXCLUDED.hold_id, hold_patient_id = EXCLUDED.hold_patient_id,
            hold_expires_at = EXCLUDED.hold_expires_at, hold_deadline_at = EXCLUDED.hold_deadline_at,
            version = slots.version + 1, updated_at = now()
      WHERE slots.status = 'open' AND slots.kind = 'composite'
     RETURNING ${HOLD_COLUMNS}`,
    [doctorId, start, minutes, patientId, lease, ttl],
  );
  if (!rows[0]) throw conflict('slot_unavailable', 'That time is already held or booked');
  return rows[0];
}

/**
 * Renews a live hold's lease: expires = min(now + lease, deadline). The open booking page calls this every 30 s,
 * so a closed tab lets the hold lapse within one lease. Not an event: nothing anyone else sees has changed.
 */
export async function heartbeatHold(tx: Tx, holdId: string, leaseSeconds: number): Promise<Hold> {
  const { rows } = await tx.query<Hold>(
    `UPDATE slots
        SET hold_expires_at = least(now() + make_interval(secs => $2::int), coalesce(hold_deadline_at, hold_expires_at))
      WHERE hold_id = $1 AND status = 'held' AND hold_expires_at >= now()
      RETURNING ${HOLD_COLUMNS}`,
    [holdId, leaseSeconds],
  );
  if (!rows[0]) throw notFound('hold_not_found', 'No live hold with this id (it may have lapsed)');
  return rows[0];
}

/** The patient's live holds, so a reopened tab can pick its hold back up. */
export async function liveHoldsForPatient(pool: Pool, patientId: string): Promise<Hold[]> {
  const { rows } = await pool.query<Hold>(
    `SELECT ${HOLD_COLUMNS} FROM slots
      WHERE hold_patient_id = $1 AND status = 'held' AND hold_expires_at >= now()
      ORDER BY lower(during)`,
    [patientId],
  );
  return rows;
}

/** Releases a live hold early (and emits hold.released). Releasing an unknown or already-expired hold is a 404. */
export async function releaseHold(tx: Tx, holdId: string): Promise<{ released: true; slotId: string }> {
  const { rows } = await tx.query<{ slotId: string }>(
    releaseHoldsSql(`hold_id = $1 AND status = 'held' AND hold_expires_at >= now()`, 'hold.released', 'FOR UPDATE'),
    [holdId],
  );
  if (!rows[0]) throw notFound('hold_not_found', 'No live hold with this id');
  return { released: true, slotId: rows[0].slotId };
}
