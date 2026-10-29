// Writing a notification = INSERT with a dedupe_key (so a redelivered event or a re-run job adds nothing), then
// a best-effort PUBLISH to Redis patient:<id> so an open inbox updates live. If Redis is down the notification
// is still in Postgres; the bell catches up on the next page load.
import type pg from 'pg';
import type { Notification, NotificationKind } from '@ds/shared';

export type Publish = (channel: string, message: string) => Promise<unknown>;
type Db = Pick<pg.Pool, 'query'> | pg.PoolClient;

export interface NewNotification {
  patientId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  appointmentId?: string | null;
  holdId?: string | null;
  dedupeKey: string;
}

export type StoredNotification = Notification & { patientId: string };

/** Returns the new row, or null when this dedupe_key was already notified. */
export async function insertNotification(db: Db, n: NewNotification): Promise<StoredNotification | null> {
  const { rows } = await db.query<StoredNotification>(
    `INSERT INTO notifications (patient_id, kind, title, body, appointment_id, hold_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id, patient_id AS "patientId", kind, title, body, appointment_id AS "appointmentId",
               hold_id AS "holdId", created_at AS "createdAt", read_at AS "readAt"`,
    [n.patientId, n.kind, n.title, n.body, n.appointmentId ?? null, n.holdId ?? null, n.dedupeKey],
  );
  return rows[0] ?? null;
}

export async function publishNotification(publish: Publish, n: StoredNotification) {
  await publish(`patient:${n.patientId}`, JSON.stringify({ id: n.id, kind: n.kind, title: n.title })).catch(() => {});
}

/** "Dr. Priya Nair · Mon 2 Nov, 10:00 · 30 min", in the doctor's time zone. */
export async function describeVisit(db: Db, doctorId: string, start: string, end: string) {
  const { rows } = await db.query<{ text: string }>(
    `SELECT format('%s · %s · %s min', d.name, to_char($2::timestamptz AT TIME ZONE d.tz, 'Dy DD Mon, HH24:MI'),
                   (extract(epoch FROM $3::timestamptz - $2::timestamptz) / 60)::int) AS text
       FROM doctors d WHERE d.id = $1`,
    [doctorId, start, end],
  );
  return rows[0]?.text ?? 'your appointment';
}
