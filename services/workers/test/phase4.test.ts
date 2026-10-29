// Phase 4, workers side: notifier, live fan-out, reminders, the indexer ignoring holds, and the waitlist matcher
// end to end against a real booking-api (it holds slots over HTTP, like in production).
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Appointment, Hold } from '@ds/shared';
import { buildApp } from '../../booking-api/src/app.js';
import { sweepExpiredHolds } from '../../booking-api/src/jobs/hold-sweeper.js';
import { testDatabaseUrl } from '../../../test/test-db.js';
import { handleNotifierEvents } from '../src/notifier.js';
import { fanOut } from '../src/live-fanout.js';
import { sendDueReminders } from '../src/reminders.js';
import { handleEvents } from '../src/search/indexer.js';
import { handleMatcherEvents, offerNext } from '../src/waitlist/matcher.js';
import { bookingApiClient, type BookingApi } from '../src/waitlist/booking-api-client.js';
import type { RawMessage } from '../src/events.js';

process.env.LOG_LEVEL = 'silent';
const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 20 });
const noHealth = { check: async () => ({ ok: true, checkedAt: '', dependencies: {} as never }), close: async () => {} };
let app: FastifyInstance;
let api: BookingApi;
let doctorId: string;
let patients: string[];
let slots: string[];
let published: { channel: string; message: string }[];
const publish = async (channel: string, message: string) => published.push({ channel, message });

const at = (i: number) => new Date(Date.UTC(2030, 0, 7, 3, 30 + 15 * i)).toISOString(); // Mon 7 Jan 2030, 09:00 IST
const DAY = '2030-01-07';

beforeAll(async () => {
  app = await buildApp({ pool, health: noHealth, webOrigin: 'x' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  api = bookingApiClient(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`);
  doctorId = (
    await pool.query<{ id: string }>(
      `INSERT INTO doctors (name, specialty, clinic, area, lat, lng) VALUES ('Dr. Waitlist', 'ENT', 'C', 'Jayanagar', 12.93, 77.58) RETURNING id`,
    )
  ).rows[0].id;
  patients = (
    await pool.query<{ id: string }>(
      `INSERT INTO patients (name, phone) SELECT 'W' || i, '+9174' || lpad(i::text, 8, '0') FROM generate_series(1, 4) i RETURNING id`,
    )
  ).rows.map((r) => r.id);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  published = [];
  for (const sql of [
    'DELETE FROM notifications WHERE patient_id = ANY ($1)',
    'DELETE FROM waitlist_entries WHERE patient_id = ANY ($1)',
  ]) await pool.query(sql, [patients]);
  await pool.query('DELETE FROM outbox WHERE doctor_id = $1', [doctorId]);
  await pool.query(`UPDATE slots SET status = 'open', appointment_id = NULL, hold_id = NULL, hold_patient_id = NULL, hold_expires_at = NULL WHERE doctor_id = $1`, [doctorId]);
  await pool.query('DELETE FROM appointments WHERE doctor_id = $1', [doctorId]);
  await pool.query('DELETE FROM slots WHERE doctor_id = $1', [doctorId]);
  slots = (
    await pool.query<{ id: string }>(
      `INSERT INTO slots (doctor_id, during)
       SELECT $1, tstzrange(t, t + interval '15 minutes') FROM unnest($2::timestamptz[]) t ORDER BY t RETURNING id`,
      [doctorId, [0, 1].map(at)],
    )
  ).rows.map((r) => r.id);
});

const send = (method: 'POST' | 'DELETE', url: string, body?: object) =>
  app.inject({ method, url, payload: body, headers: { 'idempotency-key': randomUUID() } });

/** Outbox rows as the Kafka messages the relay would publish (we skip the broker in these tests). */
let lastSeen = 0;
async function newEvents(): Promise<RawMessage[]> {
  const { rows } = await pool.query(
    `SELECT id::text AS "eventId", event_type AS "eventType", doctor_id AS "doctorId", aggregate_id AS "aggregateId",
            created_at AS "occurredAt", payload, id AS seq
       FROM outbox WHERE doctor_id = $1 AND id > $2 ORDER BY id`,
    [doctorId, lastSeen],
  );
  if (rows.length) lastSeen = Number(rows[rows.length - 1].seq);
  return rows.map((r) => ({ key: r.doctorId, value: JSON.stringify(r) }));
}

async function book(slotId: string, patientId: string) {
  const h = (await send('POST', '/holds', { slotId, patientId })).json<Hold>();
  return (await send('POST', '/appointments', { holdId: h.holdId, visitType: 'in_person' })).json<Appointment>();
}

/** Waitlist entries in a fixed order (created_at decides who is first). */
async function waitlist(...who: number[]) {
  for (const [i, p] of who.entries()) {
    await pool.query(
      `INSERT INTO waitlist_entries (doctor_id, patient_id, desired_window, created_at)
       VALUES ($1, $2, tstzrange('${DAY} 00:00+05:30', '2030-01-08 00:00+05:30'), now() - make_interval(mins => $3))`,
      [doctorId, patients[p], 100 - i],
    );
  }
}
const entries = async () =>
  (
    await pool.query<{ patient_id: string; status: string }>(
      'SELECT patient_id, status FROM waitlist_entries WHERE doctor_id = $1 ORDER BY created_at',
      [doctorId],
    )
  ).rows.map((r) => `${patients.indexOf(r.patient_id)}:${r.status}`);
const inbox = async (p: number) =>
  (await pool.query<{ kind: string }>('SELECT kind FROM notifications WHERE patient_id = $1 ORDER BY created_at', [patients[p]])).rows.map((r) => r.kind);

describe('notifier', () => {
  it('a booking event creates one notification, even when delivered twice', async () => {
    await book(slots[0], patients[0]);
    const events = (await newEvents()).filter((m) => m.value!.includes('appointment.booked'));
    expect(await handleNotifierEvents(pool, publish, [...events, ...events])).toBe(1);
    expect(await inbox(0)).toEqual(['booked']);
    expect(published.map((p) => p.channel)).toEqual([`patient:${patients[0]}`]);
  });
});

describe('live fan-out', () => {
  it('publishes every event to doctor:<id> with its time span', async () => {
    await send('POST', '/holds', { slotId: slots[0], patientId: patients[0] });
    expect(await fanOut(publish, await newEvents())).toBe(1);
    expect(published[0].channel).toBe(`doctor:${doctorId}`);
    expect(JSON.parse(published[0].message)).toMatchObject({ doctorId, eventType: 'hold.created', start: at(0) });
  });
});

describe('search indexer', () => {
  it('ignores hold events (holds are not indexed), without even calling OpenSearch', async () => {
    await send('POST', '/holds', { slotId: slots[0], patientId: patients[0] });
    expect(await handleEvents(pool, 'http://127.0.0.1:1', 'none', await newEvents())).toBe(0);
  });
});

describe('reminders', () => {
  it('fires the 1 h reminder once for an appointment 30 minutes away, and not the 24 h one', async () => {
    const soon = new Date(Date.now() + 30 * 60_000);
    soon.setUTCSeconds(0, 0);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO slots (doctor_id, during) VALUES ($1, tstzrange($2, $2::timestamptz + interval '15 minutes')) RETURNING id`,
      [doctorId, soon.toISOString()],
    );
    await book(rows[0].id, patients[3]);
    const leads = [
      { kind: 'reminder_24h' as const, minutes: 1440, next: 60 },
      { kind: 'reminder_1h' as const, minutes: 60, next: 0 },
    ];
    await sendDueReminders(pool, publish, leads);
    await sendDueReminders(pool, publish, leads); // second run: nothing new
    expect((await inbox(3)).filter((k) => k.startsWith('reminder'))).toEqual(['reminder_1h']);
  });
});

describe('waitlist matcher (Akshay reviews this one)', () => {
  it('a cancellation is offered to the patient who waited longest, as a 10-minute hold', async () => {
    await waitlist(1, 2);
    const appt = await book(slots[0], patients[0]);
    await newEvents();
    await send('POST', `/appointments/${appt.id}/cancel`);

    expect(await handleMatcherEvents(pool, api, publish, await newEvents())).toBe(1);
    expect(await entries()).toEqual(['1:offered', '2:waiting']);
    expect(await inbox(1)).toEqual(['offer']);
    const slot = await pool.query('SELECT status, hold_patient_id, hold_expires_at FROM slots WHERE id = $1', [slots[0]]);
    expect(slot.rows[0].status).toBe('held');
    expect(slot.rows[0].hold_patient_id).toBe(patients[1]);
    expect((new Date(slot.rows[0].hold_expires_at).getTime() - Date.now()) / 1000).toBeGreaterThan(590);
  });

  it('cascade: an ignored offer expires and goes to the next in line; accepting closes the entry', async () => {
    await waitlist(1, 2);
    const appt = await book(slots[0], patients[0]);
    await send('POST', `/appointments/${appt.id}/cancel`);
    await handleMatcherEvents(pool, api, publish, await newEvents()); // offer -> patient 1

    await pool.query(`UPDATE slots SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [slots[0]]);
    await sweepExpiredHolds(pool); // patient 1 ignored it
    await handleMatcherEvents(pool, api, publish, await newEvents());
    expect(await entries()).toEqual(['1:expired', '2:offered']);
    expect(await inbox(1)).toEqual(['offer', 'offer_expired']);

    const offer = await pool.query<{ hold_id: string }>(`SELECT hold_id FROM waitlist_entries WHERE status = 'offered' AND doctor_id = $1`, [doctorId]);
    expect((await send('POST', '/appointments', { holdId: offer.rows[0].hold_id, visitType: 'video' })).statusCode).toBe(201);
    await handleMatcherEvents(pool, api, publish, await newEvents());
    expect(await entries()).toEqual(['1:expired', '2:booked']);
  });

  it('a redelivered cancellation does not make a second offer', async () => {
    await waitlist(1, 2);
    const appt = await book(slots[0], patients[0]);
    await send('POST', `/appointments/${appt.id}/cancel`);
    const batch = await newEvents();
    await handleMatcherEvents(pool, api, publish, batch);
    expect(await handleMatcherEvents(pool, api, publish, batch)).toBe(0); // at-least-once redelivery
    expect(await entries()).toEqual(['1:offered', '2:waiting']);
  });

  it('two matchers offering the same slot at once: exactly one offer, the other patient keeps waiting', async () => {
    await waitlist(1, 2);
    const freed = { doctorId, start: at(1), end: at(2) }; // 09:15-09:30
    const results = await Promise.all([
      offerNext(pool, api, publish, freed, 'e-1'),
      offerNext(pool, api, publish, freed, 'e-2'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await entries()).filter((e) => e.endsWith(':offered'))).toHaveLength(1);
    expect((await entries()).filter((e) => e.endsWith(':waiting'))).toHaveLength(1);
  });

  it('nobody waiting, or the slot already taken: no offer', async () => {
    const freed = { doctorId, start: at(1), end: at(2) }; // 09:15-09:30
    expect(await offerNext(pool, api, publish, freed, 'e-3')).toBeNull();
    await waitlist(1);
    await book(slots[1], patients[0]);
    expect(await offerNext(pool, api, publish, freed, 'e-4')).toBeNull();
    expect(await entries()).toEqual(['1:waiting']);
  });
});
