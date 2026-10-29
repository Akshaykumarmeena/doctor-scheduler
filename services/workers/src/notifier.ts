// notifier: Kafka -> patient inbox. Booking confirmations and cancellations.
// (Waitlist offers are written by the matcher and reminders by the reminder job; same inbox, same dedupe rule.)
import type pg from 'pg';
import { parseEvents, type RawMessage } from './events.js';
import { describeVisit, insertNotification, publishNotification, type Publish } from './notify.js';

const KINDS = {
  'appointment.booked': { kind: 'booked', title: 'Booking confirmed' },
  'appointment.cancelled': { kind: 'cancelled', title: 'Appointment cancelled' },
} as const;

/** Returns how many NEW notifications were created (a redelivered event creates none). */
export async function handleNotifierEvents(pool: pg.Pool, publish: Publish, messages: RawMessage[]): Promise<number> {
  let created = 0;
  for (const e of parseEvents(messages)) {
    const spec = KINDS[e.eventType as keyof typeof KINDS];
    if (!spec) continue;
    const n = await insertNotification(pool, {
      patientId: e.payload.patientId,
      kind: spec.kind,
      title: spec.title,
      body: await describeVisit(pool, e.doctorId, e.payload.start, e.payload.end),
      appointmentId: e.aggregateId,
      dedupeKey: `event:${e.eventId}:${spec.kind}`,
    });
    if (n) {
      created++;
      await publishNotification(publish, n);
    }
  }
  return created;
}
