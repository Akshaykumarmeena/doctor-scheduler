// Waitlist matcher: when a slot comes back (a cancelled appointment, or a released/expired hold), offer it to the
// patient who has waited longest for that doctor on that day, as a 10-minute hold. If they let it expire or
// decline, the slot comes back again (hold.expired / hold.released) and goes to the next person: a cascade.
//
// Phase 4's critical piece. Akshay chose mode C: Claude writes it and walks through it, and Akshay answers
// review questions before it is committed.
import type pg from 'pg';
import { parseEvents, type BookingEvent, type RawMessage } from '../events.js';
import { describeVisit, insertNotification, publishNotification, type Publish } from '../notify.js';
import type { BookingApi } from './booking-api-client.js';

export const OFFER_TTL_SECONDS = Number(process.env.OFFER_TTL_SECONDS ?? 600);

export interface FreedSlot {
  doctorId: string;
  start: string;
  end: string;
}

export interface Offer {
  entryId: string;
  patientId: string;
  holdId: string;
  expiresAt: string;
}

/**
 * Offers one freed slot to the head of the line. Returns the offer, or null if nobody is waiting or the slot is
 * already gone.
 *
 * `causeEventId` (the Kafka event that freed the slot) goes into the Idempotency-Key, so if this batch is
 * redelivered after the hold was created, booking-api replays the SAME hold instead of failing with 409.
 */
export async function offerNext(
  pool: pg.Pool,
  api: BookingApi,
  publish: Publish,
  freed: FreedSlot,
  causeEventId: string,
): Promise<Offer | null> {
  if (new Date(freed.start).getTime() <= Date.now()) return null; // nobody can use a slot in the past

  const minutes = Math.round((new Date(freed.end).getTime() - new Date(freed.start).getTime()) / 60_000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. The head of the line: the OLDEST waiting entry for this doctor whose wanted day contains the slot.
    //    FOR UPDATE locks it so no other matcher can offer it something at the same time; SKIP LOCKED means a
    //    second matcher doesn't wait, it simply takes the next person in line.
    const head = await client.query<{ id: string; patient_id: string }>(
      `SELECT id, patient_id
         FROM waitlist_entries
        WHERE doctor_id = $1
          AND status = 'waiting'
          AND desired_window @> tstzrange($2::timestamptz, $3::timestamptz)
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [freed.doctorId, freed.start, freed.end],
    );
    const entry = head.rows[0];
    if (!entry) {
      await client.query('COMMIT');
      return null;
    }

    // 2. The base slot the freed time starts at (booking-api holds by base slot + duration).
    const base = await client.query<{ id: string }>(
      `SELECT id FROM slots WHERE doctor_id = $1 AND kind = 'base' AND lower(during) = $2::timestamptz`,
      [freed.doctorId, freed.start],
    );
    if (!base.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    // 3. Ask booking-api to hold it FOR the waiting patient. 409 = someone else took it in the meantime:
    //    nothing to offer, and the entry stays 'waiting' (ROLLBACK releases our lock on it).
    const res = await api.hold(
      {
        slotId: base.rows[0].id,
        patientId: entry.patient_id,
        durationMinutes: minutes === 30 ? 30 : 15,
        ttlSeconds: OFFER_TTL_SECONDS,
      },
      `waitlist-offer:${entry.id}:${causeEventId}`,
    );
    if (res.status === 409 || res.status === 404) {
      await client.query('ROLLBACK');
      return null;
    }
    if (res.status !== 201 || !res.hold) throw new Error(`hold for waitlist entry ${entry.id} failed: HTTP ${res.status}`);
    const hold = res.hold;

    // 4. Record the offer on the entry and tell the patient, in one transaction.
    await client.query(
      `UPDATE waitlist_entries
          SET status = 'offered', hold_id = $2, offered_slot_id = $3, offered_at = now(),
              offer_expires_at = $4, updated_at = now()
        WHERE id = $1`,
      [entry.id, hold.holdId, hold.slotId, hold.expiresAt],
    );
    const notification = await insertNotification(client, {
      patientId: entry.patient_id,
      kind: 'offer',
      title: 'A slot opened up for you',
      body: `${await describeVisit(client, freed.doctorId, hold.start, hold.end)}. It's held for you for ${Math.round(OFFER_TTL_SECONDS / 60)} minutes: confirm it in My appointments.`,
      holdId: hold.holdId,
      dedupeKey: `offer:${hold.holdId}`,
    });
    await client.query('COMMIT');

    if (notification) await publishNotification(publish, notification); // after COMMIT: never announce a rollback
    return { entryId: entry.id, patientId: entry.patient_id, holdId: hold.holdId, expiresAt: hold.expiresAt };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** An offer's hold ended without a booking: close that entry (expired, or declined = released). */
async function closeOffer(pool: pg.Pool, publish: Publish, e: BookingEvent) {
  const status = e.eventType === 'hold.expired' ? 'expired' : 'cancelled';
  const { rows } = await pool.query<{ id: string; patient_id: string }>(
    `UPDATE waitlist_entries SET status = $2, updated_at = now()
      WHERE hold_id = $1 AND status = 'offered'
      RETURNING id, patient_id`,
    [e.payload.holdId, status],
  );
  if (rows[0] && status === 'expired') {
    const n = await insertNotification(pool, {
      patientId: rows[0].patient_id,
      kind: 'offer_expired',
      title: 'Your offer expired',
      body: `${await describeVisit(pool, e.doctorId, e.payload.start, e.payload.end)} went to the next person in line.`,
      holdId: e.payload.holdId,
      dedupeKey: `offer-expired:${e.payload.holdId}`,
    });
    if (n) await publishNotification(publish, n);
  }
}

/** Handles one Kafka batch, in order. Returns how many offers were made. */
export async function handleMatcherEvents(pool: pg.Pool, api: BookingApi, publish: Publish, messages: RawMessage[]) {
  let offers = 0;
  for (const e of parseEvents(messages)) {
    const freed = { doctorId: e.doctorId, start: e.payload.start, end: e.payload.end };
    switch (e.eventType) {
      case 'appointment.booked':
        // An accepted offer: the entry is done.
        await pool.query(
          `UPDATE waitlist_entries SET status = 'booked', updated_at = now()
            WHERE status = 'offered' AND offered_slot_id = $1 AND patient_id = $2`,
          [e.payload.slotId, e.payload.patientId],
        );
        break;
      case 'hold.expired':
      case 'hold.released':
        await closeOffer(pool, publish, e);
        if (await offerNext(pool, api, publish, freed, e.eventId)) offers++;
        break;
      case 'appointment.cancelled':
        if (await offerNext(pool, api, publish, freed, e.eventId)) offers++;
        break;
    }
  }
  return offers;
}
