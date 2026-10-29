// Phase 4, booking-api side: hold events in the outbox, caller-chosen hold TTL, waitlist and inbox endpoints,
// and the SSE stream (Redis -> browser).
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Hold, WaitlistEntry } from '@ds/shared';
import { buildApp } from '../src/app.js';
import { LiveHub } from '../src/live/hub.js';
import { sweepExpiredHolds } from '../src/jobs/hold-sweeper.js';
import { testDatabaseUrl } from '../../../test/test-db.js';

process.env.LOG_LEVEL = 'silent';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 10 });
const noHealth = { check: async () => ({ ok: true, checkedAt: '', dependencies: {} as never }), close: async () => {} };
const hub = new LiveHub(REDIS_URL);
const redis = new Redis(REDIS_URL);
let app: FastifyInstance;
let baseUrl: string;
let doctorId: string;
let patients: string[];
let slots: string[];

const at = (i: number) => new Date(Date.UTC(2030, 0, 7, 3, 30 + 15 * i)).toISOString(); // Mon 7 Jan 2030, 09:00 IST

beforeAll(async () => {
  app = await buildApp({ pool, health: noHealth, hub, webOrigin: 'http://localhost:3000' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  doctorId = (
    await pool.query<{ id: string }>(
      `INSERT INTO doctors (name, specialty, clinic, area, lat, lng) VALUES ('Dr. Events', 'ENT', 'C', 'HSR Layout', 12.91, 77.64) RETURNING id`,
    )
  ).rows[0].id;
  patients = (
    await pool.query<{ id: string }>(
      `INSERT INTO patients (name, phone) SELECT 'E' || i, '+9173' || lpad(i::text, 8, '0') FROM generate_series(1, 3) i RETURNING id`,
    )
  ).rows.map((r) => r.id);
});

afterAll(async () => {
  await app.close();
  await hub.close();
  redis.disconnect();
  await pool.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM outbox WHERE doctor_id = $1', [doctorId]);
  await pool.query('DELETE FROM waitlist_entries WHERE doctor_id = $1', [doctorId]);
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
const events = async () =>
  (
    await pool.query<{ event_type: string; payload: { holdId: string; patientId: string } }>(
      'SELECT event_type, payload FROM outbox WHERE doctor_id = $1 ORDER BY id',
      [doctorId],
    )
  ).rows;

describe('hold events', () => {
  it('hold, release and expiry each write an outbox event that says whose hold it was', async () => {
    const h1 = (await send('POST', '/holds', { slotId: slots[0], patientId: patients[0] })).json<Hold>();
    await send('DELETE', `/holds/${h1.holdId}`);
    const h2 = (await send('POST', '/holds', { slotId: slots[0], patientId: patients[1] })).json<Hold>();
    await pool.query(`UPDATE slots SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [slots[0]]);
    expect(await sweepExpiredHolds(pool)).toBe(1);

    expect((await events()).map((e) => [e.event_type, e.payload.holdId, e.payload.patientId])).toEqual([
      ['hold.created', h1.holdId, patients[0]],
      ['hold.released', h1.holdId, patients[0]],
      ['hold.created', h2.holdId, patients[1]],
      ['hold.expired', h2.holdId, patients[1]],
    ]);
  });

  it('an expired hold released inline by a new hold also emits hold.expired', async () => {
    const old = (await send('POST', '/holds', { slotId: slots[0], patientId: patients[0] })).json<Hold>();
    await pool.query(`UPDATE slots SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [slots[0]]);
    expect((await send('POST', '/holds', { slotId: slots[0], patientId: patients[1] })).statusCode).toBe(201);
    expect((await events()).map((e) => e.event_type)).toEqual(['hold.created', 'hold.expired', 'hold.created']);
    expect((await events())[1].payload.holdId).toBe(old.holdId);
  });

  it('accepts a caller-chosen TTL between 60 and 900 seconds', async () => {
    const res = await send('POST', '/holds', { slotId: slots[0], patientId: patients[0], ttlSeconds: 600 });
    const seconds = (new Date(res.json<Hold>().expiresAt).getTime() - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(590);
    expect(seconds).toBeLessThanOrEqual(600);
    expect((await send('POST', '/holds', { slotId: slots[1], patientId: patients[0], ttlSeconds: 30 })).statusCode).toBe(400);
  });
});

describe('waitlist endpoints', () => {
  it('join, list, refuse a duplicate, and leave', async () => {
    const join = await send('POST', '/waitlist', { doctorId, patientId: patients[0], date: '2030-01-07' });
    expect(join.statusCode).toBe(201);
    const entry = join.json<WaitlistEntry>();
    expect(entry).toMatchObject({ doctorId, patientId: patients[0], date: '2030-01-07', status: 'waiting', offer: null });

    expect((await send('POST', '/waitlist', { doctorId, patientId: patients[0], date: '2030-01-07' })).statusCode).toBe(409);
    const list = await app.inject({ method: 'GET', url: `/patients/${patients[0]}/waitlist` });
    expect(list.json().entries.map((e: WaitlistEntry) => e.id)).toContain(entry.id);

    expect((await send('DELETE', `/waitlist/${entry.id}`)).json().status).toBe('cancelled');
    expect((await send('DELETE', `/waitlist/${entry.id}`)).statusCode).toBe(409);
  });

  it('rejects a day that is already over', async () => {
    expect((await send('POST', '/waitlist', { doctorId, patientId: patients[0], date: '2020-01-01' })).statusCode).toBe(422);
  });
});

describe('inbox endpoints', () => {
  it('lists notifications with an unread count, and marking read is idempotent', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO notifications (patient_id, kind, title, body, dedupe_key)
       VALUES ($1, 'booked', 'Booking confirmed', 'x', $2) RETURNING id`,
      [patients[2], randomUUID()],
    );
    const before = await app.inject({ method: 'GET', url: `/patients/${patients[2]}/notifications?unread=true` });
    expect(before.json().unread).toBeGreaterThanOrEqual(1);

    const first = (await send('POST', `/notifications/${rows[0].id}/read`)).json();
    const second = (await send('POST', `/notifications/${rows[0].id}/read`)).json();
    expect(first.readAt).not.toBeNull();
    expect(second.readAt).toBe(first.readAt);
  });
});

describe('SSE stream', () => {
  it('forwards a Redis message for this doctor and day to the browser, and skips other days', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${baseUrl}/doctors/${doctorId}/slots/stream?date=2030-01-07`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(': connected')) text += decoder.decode((await reader.read()).value);

    const event = (start: string) =>
      JSON.stringify({ doctorId, eventType: 'hold.created', start, end: start, at: new Date().toISOString() });
    await redis.publish(`doctor:${doctorId}`, event('2030-01-08T04:00:00.000Z')); // another day: skipped
    await redis.publish(`doctor:${doctorId}`, event(at(1))); // this day: forwarded

    while (!text.includes('event: slots-changed')) text += decoder.decode((await reader.read()).value);
    ctrl.abort();
    const frames = text.split('\n\n').filter((f) => f.startsWith('event:'));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain(at(1));
  });
});
