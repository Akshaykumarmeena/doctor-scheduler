// The patient inbox. Notifications are written by workers (notifier, waitlist matcher, reminders);
// the API only lists them and marks them read.
import type { Notification } from '@ds/shared';
import type { Pool } from './db.js';
import { notFound } from './errors.js';
import type { Tx } from './idempotency.js';

const COLUMNS = `id, kind, title, body, appointment_id AS "appointmentId", hold_id AS "holdId",
  created_at AS "createdAt", read_at AS "readAt"`;

export async function listNotifications(pool: Pool, patientId: string, unreadOnly: boolean) {
  const [list, count] = await Promise.all([
    pool.query<Notification>(
      `SELECT ${COLUMNS} FROM notifications
        WHERE patient_id = $1 AND ($2::boolean IS FALSE OR read_at IS NULL)
        ORDER BY created_at DESC LIMIT 50`,
      [patientId, unreadOnly],
    ),
    pool.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE patient_id = $1 AND read_at IS NULL', [patientId]),
  ]);
  return { notifications: list.rows, unread: count.rows[0].n };
}

/** Idempotent by nature too: marking an already-read notification keeps its first read time. */
export async function markRead(tx: Tx, id: string): Promise<Notification> {
  const { rows } = await tx.query<Notification>(
    `UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = $1 RETURNING ${COLUMNS}`,
    [id],
  );
  if (!rows[0]) throw notFound('notification_not_found', 'No such notification');
  return rows[0];
}
