// Reminders: no Kafka needed. Every minute, find confirmed appointments that are now inside a reminder window
// and have no reminder of that kind yet. dedupe_key = appointment + kind, so each fires exactly once even if the
// job runs on two machines or is restarted.
import type pg from 'pg';
import type { NotificationKind } from '@ds/shared';
import { publishNotification, type Publish, type StoredNotification } from './notify.js';

/** REMINDER_LEAD_MINUTES="1440,60": the first lead is the "24 h" reminder, the second the "1 h" one. */
export function reminderLeads(env = process.env.REMINDER_LEAD_MINUTES ?? '1440,60') {
  const [day, hour] = env.split(',').map(Number);
  return [
    { kind: 'reminder_24h' as NotificationKind, minutes: day, next: hour },
    { kind: 'reminder_1h' as NotificationKind, minutes: hour, next: 0 },
  ];
}

export async function sendDueReminders(pool: pg.Pool, publish: Publish, leads = reminderLeads()): Promise<number> {
  let sent = 0;
  for (const lead of leads) {
    // Start is within this lead but NOT within the next, shorter one: an appointment booked 30 minutes ahead
    // gets only the "1 h" reminder, not both at once.
    const { rows } = await pool.query<StoredNotification>(
      `INSERT INTO notifications (patient_id, kind, title, body, appointment_id, dedupe_key)
       SELECT a.patient_id, $1, 'Reminder: appointment coming up',
              format('%s · %s · in %s min', d.name, to_char(lower(s.during) AT TIME ZONE d.tz, 'Dy DD Mon, HH24:MI'),
                     ceil(extract(epoch FROM lower(s.during) - now()) / 60)::int),
              a.id, a.id || ':' || $1
         FROM appointments a
         JOIN slots s ON s.id = a.slot_id
         JOIN doctors d ON d.id = a.doctor_id
        WHERE a.status = 'confirmed'
          AND lower(s.during) > now() + make_interval(mins => $3::int)
          AND lower(s.during) <= now() + make_interval(mins => $2::int)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id, patient_id AS "patientId", kind, title, body, appointment_id AS "appointmentId",
                 hold_id AS "holdId", created_at AS "createdAt", read_at AS "readAt"`,
      [lead.kind, lead.minutes, lead.next],
    );
    for (const n of rows) await publishNotification(publish, n);
    sent += rows.length;
  }
  return sent;
}
