// 30-minute visits stored as one composite slot row over two 15-minute base rows (ADR 0004).
// The EXCLUDE constraint is what keeps composite and base commitments from overlapping.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Appointment, Hold } from '@ds/shared';
import { buildApp } from '../src/app.js';
import { testDatabaseUrl } from '../../../test/test-db.js';

process.env.LOG_LEVEL = 'silent';
const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 20 });
const noHealth = { check: async () => ({ ok: true, checkedAt: '', dependencies: {} as never }), close: async () => {} };
let app: FastifyInstance;
let doctorId: string;
let patientIds: string[];
let base: string[]; // 09:00, 09:15, 09:30, 09:45 on Mon 7 Jan 2030 (IST)

const at = (i: number) => new Date(Date.UTC(2030, 0, 7, 3, 30 + 15 * i)).toISOString();

beforeAll(async () => {
  app = await buildApp({ pool, health: noHealth, webOrigin: 'http://localhost:3000' });
  doctorId = (
    await pool.query<{ id: string }>(
      `INSERT INTO doctors (name, specialty, clinic, area, lat, lng) VALUES ('Dr. Thirty', 'ENT', 'C', 'Jayanagar', 12.93, 77.58) RETURNING id`,
    )
  ).rows[0].id;
  patientIds = (
    await pool.query<{ id: string }>(
      `INSERT INTO patients (name, phone) SELECT 'T' || i, '+9171' || lpad(i::text, 8, '0') FROM generate_series(1, 60) i RETURNING id`,
    )
  ).rows.map((r) => r.id);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM outbox WHERE doctor_id = $1', [doctorId]);
  await pool.query(
    `UPDATE slots SET status = 'open', appointment_id = NULL, hold_id = NULL, hold_patient_id = NULL, hold_expires_at = NULL
      WHERE doctor_id = $1`,
    [doctorId],
  );
  await pool.query('DELETE FROM appointments WHERE doctor_id = $1', [doctorId]);
  await pool.query('DELETE FROM slots WHERE doctor_id = $1', [doctorId]);
  base = (
    await pool.query<{ id: string }>(
      `INSERT INTO slots (doctor_id, during)
       SELECT $1, tstzrange(t, t + interval '15 minutes') FROM unnest($2::timestamptz[]) t ORDER BY t RETURNING id`,
      [doctorId, [0, 1, 2, 3].map(at)],
    )
  ).rows.map((r) => r.id);
});

const send = (method: 'POST' | 'DELETE', url: string, body?: object) =>
  app.inject({ method, url, payload: body, headers: { 'idempotency-key': randomUUID() } });
const hold = (slotId: string, patientId: string, durationMinutes?: 15 | 30) =>
  send('POST', '/holds', { slotId, patientId, ...(durationMinutes ? { durationMinutes } : {}) });
const grid = async () =>
  (await app.inject({ method: 'GET', url: `/doctors/${doctorId}/slots?date=2030-01-07` }))
    .json()
    .slots.map((s: { localTime: string; status: string }) => `${s.localTime} ${s.status}`);

/** No two live commitments of this doctor overlap: the invariant everything else exists to protect. */
async function overlappingCommitments() {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM slots a JOIN slots b
        ON a.doctor_id = b.doctor_id AND a.id < b.id AND a.during && b.during
     WHERE a.doctor_id = $1
       AND a.status IN ('held', 'booked') AND b.status IN ('held', 'booked')`,
    [doctorId],
  );
  return rows[0].n;
}

describe('30-minute visits', () => {
  it('a 30-minute hold creates one composite row and shows both 15-minute slots as held', async () => {
    const res = await hold(base[0], patientIds[0], 30);
    expect(res.statusCode).toBe(201);
    const h = res.json<Hold>();
    expect([new Date(h.start).toISOString(), new Date(h.end).toISOString()]).toEqual([at(0), at(2)]);
    expect(await grid()).toEqual(['09:00 held', '09:15 held', '09:30 open', '09:45 open']);
  });

  it('a 15-minute hold under a live 30-minute hold is rejected by the EXCLUDE constraint (409)', async () => {
    await hold(base[0], patientIds[0], 30);
    const res = await hold(base[1], patientIds[1]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('slot_unavailable');
  });

  it('a 30-minute hold over a booked 15-minute slot is rejected (409)', async () => {
    const h = (await hold(base[1], patientIds[0])).json<Hold>();
    await send('POST', '/appointments', { holdId: h.holdId, visitType: 'in_person' });
    expect((await hold(base[0], patientIds[1], 30)).statusCode).toBe(409); // 09:00-09:30 covers 09:15
    expect((await hold(base[2], patientIds[1], 30)).statusCode).toBe(201); // 09:30-10:00 is free
  });

  it('rejects a 30-minute visit that runs past the end of the doctor\'s hours', async () => {
    const res = await hold(base[3], patientIds[0], 30); // 09:45-10:15, but there is no 10:00 slot
    expect(res.statusCode).toBe(409);
  });

  it('50 racers mixing 15- and 30-minute holds: at least one wins and nothing overlaps', async () => {
    const attempts = patientIds.slice(0, 50).map((p, i) =>
      i % 3 === 0 ? hold(base[1], p) : i % 3 === 1 ? hold(base[0], p, 30) : hold(base[1], p, 30),
    );
    const codes = (await Promise.all(attempts)).map((r) => r.statusCode);
    expect(codes.every((c) => c === 201 || c === 409)).toBe(true);
    expect(codes.filter((c) => c === 201).length).toBeGreaterThanOrEqual(1);
    expect(await overlappingCommitments()).toBe(0);
  });

  it('an expired 30-minute hold frees the 15-minute slots immediately, without the sweeper', async () => {
    await hold(base[0], patientIds[0], 30);
    await pool.query(`UPDATE slots SET hold_expires_at = now() - interval '1 second' WHERE doctor_id = $1 AND status = 'held'`, [doctorId]);
    expect((await hold(base[1], patientIds[1])).statusCode).toBe(201);
  });

  it('confirm books 30 minutes; cancel frees both slots; a new 30-minute hold reuses the same composite row', async () => {
    const h = (await hold(base[0], patientIds[0], 30)).json<Hold>();
    const appt = (await send('POST', '/appointments', { holdId: h.holdId, visitType: 'video' })).json<Appointment>();
    expect(new Date(appt.end).getTime() - new Date(appt.start).getTime()).toBe(30 * 60_000);
    expect(await grid()).toEqual(['09:00 booked', '09:15 booked', '09:30 open', '09:45 open']);

    expect((await send('POST', `/appointments/${appt.id}/cancel`)).statusCode).toBe(200);
    expect(await grid()).toEqual(['09:00 open', '09:15 open', '09:30 open', '09:45 open']);

    const again = (await hold(base[0], patientIds[1], 30)).json<Hold>();
    expect(again.slotId).toBe(h.slotId);
  });

  it('My appointments lists the patient\'s bookings with doctor details', async () => {
    const h = (await hold(base[0], patientIds[0], 30)).json<Hold>();
    await send('POST', '/appointments', { holdId: h.holdId, visitType: 'in_person' });
    const res = await app.inject({ method: 'GET', url: `/patients/${patientIds[0]}/appointments` });
    expect(res.statusCode).toBe(200);
    expect(res.json().appointments[0]).toMatchObject({ doctorName: 'Dr. Thirty', status: 'confirmed' });
  });
});
