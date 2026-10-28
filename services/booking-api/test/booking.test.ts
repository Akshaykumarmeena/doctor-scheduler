// End-to-end tests of the booking API against a real Postgres (scheduler_test), through HTTP (app.inject).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Appointment, Hold } from '@ds/shared';
import { buildApp } from '../src/app.js';
import { sweepExpiredHolds } from '../src/jobs/hold-sweeper.js';
import { testDatabaseUrl } from '../../../test/test-db.js';

process.env.LOG_LEVEL = 'silent';
const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 20 });
const noHealth = { check: async () => ({ ok: true, checkedAt: '', dependencies: {} as never }), close: async () => {} };
let app: FastifyInstance;
let doctorId: string;
let patientIds: string[];

// 2030-01-07 is a Monday; 09:00 IST = 03:30Z. Far in the future so "slot in the past" never triggers.
const slotStart = (i: number) => new Date(Date.UTC(2030, 0, 7, 3, 30 + 15 * i)).toISOString();

beforeAll(async () => {
  app = await buildApp({ pool, health: noHealth, webOrigin: 'http://localhost:3000' });
  const d = await pool.query<{ id: string }>(
    `INSERT INTO doctors (name, specialty, clinic, area, lat, lng) VALUES ('Dr. Booking', 'ENT', 'C', 'HSR Layout', 12.91, 77.64) RETURNING id`,
  );
  doctorId = d.rows[0].id;
  const p = await pool.query<{ id: string }>(
    `INSERT INTO patients (name, phone) SELECT 'P' || i, '+9170' || lpad(i::text, 8, '0') FROM generate_series(1, 60) i RETURNING id`,
  );
  patientIds = p.rows.map((r) => r.id);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

let slotIds: string[];
beforeEach(async () => {
  // Fresh doctor state for every test: 4 open 15-minute slots from 09:00 IST.
  await pool.query('DELETE FROM outbox WHERE doctor_id = $1', [doctorId]);
  await pool.query(
    `UPDATE slots SET status = 'open', appointment_id = NULL, hold_id = NULL, hold_patient_id = NULL, hold_expires_at = NULL
      WHERE doctor_id = $1`,
    [doctorId],
  );
  await pool.query('DELETE FROM appointments WHERE doctor_id = $1', [doctorId]);
  await pool.query('DELETE FROM slots WHERE doctor_id = $1', [doctorId]);
  const s = await pool.query<{ id: string }>(
    `INSERT INTO slots (doctor_id, during)
     SELECT $1, tstzrange(t, t + interval '15 minutes') FROM unnest($2::timestamptz[]) t ORDER BY t RETURNING id`,
    [doctorId, [0, 1, 2, 3].map(slotStart)],
  );
  slotIds = s.rows.map((r) => r.id);
});

function send(method: 'POST' | 'DELETE', url: string, body?: object, key: string | null = randomUUID()) {
  return app.inject({ method, url, payload: body, headers: key ? { 'idempotency-key': key } : {} });
}
const hold = (slotId: string, patientId: string, key?: string) => send('POST', '/holds', { slotId, patientId }, key);
const confirm = (holdId: string, key?: string) => send('POST', '/appointments', { holdId, visitType: 'in_person' }, key);
const outbox = async (type: string) =>
  (await pool.query('SELECT * FROM outbox WHERE doctor_id = $1 AND event_type = $2', [doctorId, type])).rows;

describe('holds', () => {
  it('50 patients race for one slot: exactly one hold wins, 49 get 409', async () => {
    const results = await Promise.all(patientIds.slice(0, 50).map((p) => hold(slotIds[0], p)));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(49);
    const { rows } = await pool.query('SELECT status, version FROM slots WHERE id = $1', [slotIds[0]]);
    expect(rows[0]).toEqual({ status: 'held', version: 2 });
  });

  it('requires an Idempotency-Key', async () => {
    const res = await send('POST', '/holds', { slotId: slotIds[0], patientId: patientIds[0] }, null);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('idempotency_key_required');
  });

  it('replays the same answer for a retried key, and rejects the key with a different body (422)', async () => {
    const key = randomUUID();
    const first = await hold(slotIds[0], patientIds[0], key);
    const retry = await hold(slotIds[0], patientIds[0], key);
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(first.json());
    expect(retry.headers['idempotent-replayed']).toBe('true');

    const reused = await hold(slotIds[1], patientIds[0], key);
    expect(reused.statusCode).toBe(422);
  });

  it('an expired hold is free again: another patient can take it, and the sweeper reopens leftovers', async () => {
    const h = (await hold(slotIds[0], patientIds[0])).json<Hold>();
    await hold(slotIds[1], patientIds[1]);
    await pool.query(`UPDATE slots SET hold_expires_at = now() - interval '1 second' WHERE doctor_id = $1 AND status = 'held'`, [doctorId]);

    expect((await confirm(h.holdId)).statusCode).toBe(409); // too late
    expect((await hold(slotIds[0], patientIds[2])).statusCode).toBe(201); // re-held without waiting for a sweep

    expect(await sweepExpiredHolds(pool)).toBeGreaterThanOrEqual(1); // slot 1's expired hold
    const { rows } = await pool.query('SELECT status FROM slots WHERE id = $1', [slotIds[1]]);
    expect(rows[0].status).toBe('open');
  });

  it('releases a hold early', async () => {
    const h = (await hold(slotIds[0], patientIds[0])).json<Hold>();
    expect((await send('DELETE', `/holds/${h.holdId}`)).statusCode).toBe(200);
    expect((await hold(slotIds[0], patientIds[1])).statusCode).toBe(201);
  });
});

describe('confirm (Akshay writes services/booking-api/src/booking/confirm.ts)', () => {
  it('turns a hold into an appointment, books the slot and writes one outbox event', async () => {
    const h = (await hold(slotIds[0], patientIds[0])).json<Hold>();
    const res = await confirm(h.holdId);
    expect(res.statusCode).toBe(201);
    const appt = res.json<Appointment>();
    expect(appt).toMatchObject({ slotId: slotIds[0], doctorId, patientId: patientIds[0], status: 'confirmed', visitType: 'in_person' });
    expect(new Date(appt.start).toISOString()).toBe(slotStart(0));

    const slot = await pool.query('SELECT status, appointment_id, hold_id FROM slots WHERE id = $1', [slotIds[0]]);
    expect(slot.rows[0]).toEqual({ status: 'booked', appointment_id: appt.id, hold_id: null });
    const events = await outbox('appointment.booked');
    expect(events).toHaveLength(1);
    expect(events[0].aggregate_id).toBe(appt.id);
  });

  it('a retried confirm (same key) returns the same appointment: no second row, no second event', async () => {
    const h = (await hold(slotIds[0], patientIds[0])).json<Hold>();
    const key = randomUUID();
    const [a, b] = await Promise.all([confirm(h.holdId, key), confirm(h.holdId, key)]); // even concurrently
    const c = await confirm(h.holdId, key);
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([201, 201, 201]);
    expect(new Set([a.json().id, b.json().id, c.json().id]).size).toBe(1);
    const count = await pool.query('SELECT count(*)::int AS n FROM appointments WHERE slot_id = $1', [slotIds[0]]);
    expect(count.rows[0].n).toBe(1);
    expect(await outbox('appointment.booked')).toHaveLength(1);
  });

  it('a second confirm of the same hold with a NEW key is rejected (409), not double-booked', async () => {
    const h = (await hold(slotIds[0], patientIds[0])).json<Hold>();
    expect((await confirm(h.holdId)).statusCode).toBe(201);
    expect((await confirm(h.holdId)).statusCode).toBe(409);
  });

  it('a rejected confirm leaves nothing behind: no appointment, no outbox row', async () => {
    expect((await confirm(randomUUID())).statusCode).toBe(409);
    const count = await pool.query('SELECT count(*)::int AS n FROM appointments WHERE doctor_id = $1', [doctorId]);
    expect(count.rows[0].n).toBe(0);
    expect(await outbox('appointment.booked')).toHaveLength(0);
  });
});

describe('cancel', () => {
  it('cancels, reopens the slot, emits appointment.cancelled, and the slot can be booked again', async () => {
    const h = (await hold(slotIds[0], patientIds[0])).json<Hold>();
    const appt = (await confirm(h.holdId)).json<Appointment>();
    const res = await send('POST', `/appointments/${appt.id}/cancel`);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');
    expect(await outbox('appointment.cancelled')).toHaveLength(1);

    const again = (await hold(slotIds[0], patientIds[1])).json<Hold>();
    expect((await confirm(again.holdId)).statusCode).toBe(201);
  });
});

describe('reads', () => {
  it('lists a local day of slots with the doctor-local time', async () => {
    const res = await app.inject({ method: 'GET', url: `/doctors/${doctorId}/slots?date=2030-01-07` });
    expect(res.statusCode).toBe(200);
    const slots = res.json().slots;
    expect(slots.map((s: { localTime: string }) => s.localTime)).toEqual(['09:00', '09:15', '09:30', '09:45']);
    expect(slots[0].status).toBe('open');
  });
});
