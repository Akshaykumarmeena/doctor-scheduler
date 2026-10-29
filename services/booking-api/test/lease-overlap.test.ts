// Phase 4 additions: closed-tab leases (heartbeat), and one patient can't be in two places at once.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Hold } from '@ds/shared';
import { buildApp } from '../src/app.js';
import { sweepExpiredHolds } from '../src/jobs/hold-sweeper.js';
import { testDatabaseUrl } from '../../../test/test-db.js';

process.env.LOG_LEVEL = 'silent';
const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 10 });
const noHealth = { check: async () => ({ ok: true, checkedAt: '', dependencies: {} as never }), close: async () => {} };
let app: FastifyInstance;
let doctors: string[];
let patient: string;
let other: string;
/** slots[d][i]: doctor d's i-th 15-minute slot from 09:00 IST on Mon 7 Jan 2030 */
let slots: string[][];

const at = (i: number) => new Date(Date.UTC(2030, 0, 7, 3, 30 + 15 * i)).toISOString();
const secondsUntil = (iso: string) => (new Date(iso).getTime() - Date.now()) / 1000;

beforeAll(async () => {
  app = await buildApp({ pool, health: noHealth, webOrigin: 'x' });
  doctors = (
    await pool.query<{ id: string }>(
      `INSERT INTO doctors (name, specialty, clinic, area, lat, lng)
       SELECT 'Dr. Lease ' || i, 'ENT', 'C', 'HSR Layout', 12.91, 77.64 FROM generate_series(1, 4) i RETURNING id`,
    )
  ).rows.map((r) => r.id);
  [patient, other] = (
    await pool.query<{ id: string }>(
      `INSERT INTO patients (name, phone) SELECT 'L' || i, '+9175' || lpad(i::text, 8, '0') FROM generate_series(1, 2) i RETURNING id`,
    )
  ).rows.map((r) => r.id);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    `UPDATE slots SET status = 'open', appointment_id = NULL, hold_id = NULL, hold_patient_id = NULL, hold_expires_at = NULL
      WHERE doctor_id = ANY ($1)`,
    [doctors],
  );
  await pool.query('DELETE FROM appointments WHERE doctor_id = ANY ($1)', [doctors]);
  await pool.query('DELETE FROM slots WHERE doctor_id = ANY ($1)', [doctors]);
  slots = [];
  for (const d of doctors) {
    slots.push(
      (
        await pool.query<{ id: string }>(
          `INSERT INTO slots (doctor_id, during)
           SELECT $1, tstzrange(t, t + interval '15 minutes') FROM unnest($2::timestamptz[]) t ORDER BY t RETURNING id`,
          [d, [0, 1, 2].map(at)],
        )
      ).rows.map((r) => r.id),
    );
  }
});

const send = (method: 'POST' | 'DELETE', url: string, body?: object) =>
  app.inject({ method, url, payload: body, headers: { 'idempotency-key': randomUUID() } });
const hold = (slotId: string, p = patient, extra: object = {}) => send('POST', '/holds', { slotId, patientId: p, ...extra });

describe('closed-tab lease', () => {
  it('a booking-page hold lives 2 minutes (lease) inside a 5-minute deadline', async () => {
    const h = (await hold(slots[0][0], patient, { leaseSeconds: 120 })).json<Hold>();
    expect(secondsUntil(h.expiresAt)).toBeGreaterThan(115);
    expect(secondsUntil(h.expiresAt)).toBeLessThanOrEqual(120);
    expect(secondsUntil(h.deadlineAt)).toBeGreaterThan(295);
  });

  it('a heartbeat renews the lease, but never past the deadline', async () => {
    const h = (await hold(slots[0][0], patient, { leaseSeconds: 120 })).json<Hold>();
    await pool.query(`UPDATE slots SET hold_expires_at = now() + interval '5 seconds' WHERE hold_id = $1`, [h.holdId]);
    const beat = (await send('POST', `/holds/${h.holdId}/heartbeat`, { leaseSeconds: 120 })).json<Hold>();
    expect(secondsUntil(beat.expiresAt)).toBeGreaterThan(115);

    await pool.query(`UPDATE slots SET hold_deadline_at = now() + interval '30 seconds' WHERE hold_id = $1`, [h.holdId]);
    const capped = (await send('POST', `/holds/${h.holdId}/heartbeat`, { leaseSeconds: 120 })).json<Hold>();
    expect(capped.expiresAt).toBe(capped.deadlineAt);
  });

  it('no heartbeat (tab closed): the hold lapses, is swept, and the slot is free; a late heartbeat gets 404', async () => {
    const h = (await hold(slots[0][0], patient, { leaseSeconds: 120 })).json<Hold>();
    await pool.query(`UPDATE slots SET hold_expires_at = now() - interval '1 second' WHERE hold_id = $1`, [h.holdId]);
    expect(await sweepExpiredHolds(pool)).toBeGreaterThanOrEqual(1);
    expect((await send('POST', `/holds/${h.holdId}/heartbeat`)).statusCode).toBe(404);
    expect((await hold(slots[0][0], other)).statusCode).toBe(201);
  });

  it('a reopened tab finds the live hold again', async () => {
    const h = (await hold(slots[0][0], patient, { leaseSeconds: 120 })).json<Hold>();
    const res = await app.inject({ method: 'GET', url: `/patients/${patient}/holds` });
    expect(res.json().holds.map((x: Hold) => x.holdId)).toEqual([h.holdId]);
  });

  it('without a lease (e.g. a waitlist offer) the hold is fixed: lease = TTL', async () => {
    const h = (await hold(slots[0][0], patient, { ttlSeconds: 600 })).json<Hold>();
    expect(h.expiresAt).toBe(h.deadlineAt);
    expect(secondsUntil(h.expiresAt)).toBeGreaterThan(595);
  });
});

describe('one patient, one place at a time', () => {
  it('cannot hold the same time with two doctors (EXCLUDE on hold_patient_id)', async () => {
    expect((await hold(slots[0][1])).statusCode).toBe(201);
    const res = await hold(slots[1][1]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('patient_busy');
    expect((await hold(slots[1][2])).statusCode).toBe(201); // a different time is fine
  });

  it('cannot hold a time they already have an appointment at', async () => {
    const h = (await hold(slots[0][1])).json<Hold>();
    expect((await send('POST', '/appointments', { holdId: h.holdId, visitType: 'in_person' })).statusCode).toBe(201);
    const res = await hold(slots[1][1]);
    expect([res.statusCode, res.json().error]).toEqual([409, 'patient_busy']);
  });

  it('the database refuses two overlapping confirmed appointments for one patient, whoever writes them', async () => {
    const insert = (slotId: string, doctorId: string) =>
      pool.query(
        `INSERT INTO appointments (slot_id, doctor_id, patient_id, visit_type, idempotency_key)
         VALUES ($1, $2, $3, 'in_person', gen_random_uuid()::text)`,
        [slotId, doctorId, other],
      );
    await insert(slots[2][0], doctors[2]);
    const err = await insert(slots[3][0], doctors[3]).then(() => null, (e: pg.DatabaseError) => e);
    expect([err?.code, err?.constraint]).toEqual(['23P01', 'appointments_patient_no_overlap']);
  });

  it('at most 3 live holds per patient', async () => {
    for (let d = 0; d < 3; d++) expect((await hold(slots[d][d])).statusCode).toBe(201);
    const res = await hold(slots[3][0]);
    expect([res.statusCode, res.json().error]).toEqual([409, 'too_many_holds']);
  });

  it("an expired hold of the patient's own doesn't block their next one", async () => {
    const h = (await hold(slots[0][1])).json<Hold>();
    await pool.query(`UPDATE slots SET hold_expires_at = now() - interval '1 second' WHERE hold_id = $1`, [h.holdId]);
    expect((await hold(slots[1][1])).statusCode).toBe(201);
  });
});
