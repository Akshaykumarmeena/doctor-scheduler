// Waitlist: a patient asks for "any slot with this doctor on this day". The waitlist matcher (workers) offers
// freed slots to the oldest waiting entry; joining, leaving and reading happen here.
import type { WaitlistEntry } from '@ds/shared';
import type { Pool } from './db.js';
import { conflict, notFound, unprocessable } from './errors.js';
import type { Tx } from './idempotency.js';
import { releaseHold } from './booking/holds.js';

const ENTRY_SQL = `
  SELECT w.id, w.doctor_id AS "doctorId", w.patient_id AS "patientId",
         to_char(lower(w.desired_window) AT TIME ZONE d.tz, 'YYYY-MM-DD') AS date,
         w.status,
         CASE WHEN w.status = 'offered' THEN json_build_object(
                'holdId', w.hold_id, 'slotId', w.offered_slot_id,
                'start', lower(s.during), 'end', upper(s.during), 'expiresAt', w.offer_expires_at)
         END AS offer,
         w.created_at AS "createdAt"
    FROM waitlist_entries w
    JOIN doctors d ON d.id = w.doctor_id
    LEFT JOIN slots s ON s.id = w.offered_slot_id`;

async function getEntry(db: Tx | Pool, id: string): Promise<WaitlistEntry> {
  const { rows } = await db.query<WaitlistEntry>(`${ENTRY_SQL} WHERE w.id = $1`, [id]);
  return rows[0];
}

/** Join the waitlist for one doctor-local day (the whole day is the wanted window). */
export async function joinWaitlist(tx: Tx, input: { doctorId: string; patientId: string; date: string }): Promise<WaitlistEntry> {
  const doctor = await tx.query<{ past: boolean }>(
    `SELECT $2::date < (now() AT TIME ZONE tz)::date AS past FROM doctors WHERE id = $1`,
    [input.doctorId, input.date],
  );
  if (!doctor.rows[0]) throw notFound('doctor_not_found', 'No such doctor');
  if (doctor.rows[0].past) throw unprocessable('date_in_past', 'That day is already over');

  const inserted = await tx
    .query<{ id: string }>(
      `INSERT INTO waitlist_entries (doctor_id, patient_id, desired_window)
       SELECT d.id, $2, tstzrange($3::date::timestamp AT TIME ZONE d.tz, ($3::date + 1)::timestamp AT TIME ZONE d.tz)
         FROM doctors d WHERE d.id = $1
       RETURNING id`,
      [input.doctorId, input.patientId, input.date],
    )
    .catch((err: { code?: string; constraint?: string }) => {
      if (err.code === '23505') throw conflict('already_waitlisted', 'Already on this doctor’s waitlist for that day');
      if (err.code === '23503') throw unprocessable('patient_not_found', 'No such patient');
      throw err;
    });
  return getEntry(tx, inserted.rows[0].id);
}

/** Leave the waitlist. If an offer is open, its hold is released too, so the slot goes to the next person. */
export async function leaveWaitlist(tx: Tx, id: string): Promise<WaitlistEntry> {
  const { rows } = await tx.query<{ hold_id: string | null }>(
    `UPDATE waitlist_entries SET status = 'cancelled', updated_at = now()
      WHERE id = $1 AND status IN ('waiting', 'offered')
      RETURNING CASE WHEN offer_expires_at >= now() THEN hold_id END AS hold_id`,
    [id],
  );
  if (!rows[0]) {
    const exists = await tx.query('SELECT 1 FROM waitlist_entries WHERE id = $1', [id]);
    if (exists.rowCount === 0) throw notFound('waitlist_entry_not_found', 'No such waitlist entry');
    throw conflict('waitlist_entry_closed', 'This waitlist entry is no longer active');
  }
  if (rows[0].hold_id) await releaseHold(tx, rows[0].hold_id).catch(() => {}); // already expired: nothing to release
  return getEntry(tx, id);
}

export async function waitlistForPatient(pool: Pool, patientId: string): Promise<WaitlistEntry[]> {
  const { rows } = await pool.query<WaitlistEntry>(
    `${ENTRY_SQL} WHERE w.patient_id = $1 ORDER BY w.status IN ('waiting', 'offered') DESC, w.created_at DESC LIMIT 50`,
    [patientId],
  );
  return rows;
}
