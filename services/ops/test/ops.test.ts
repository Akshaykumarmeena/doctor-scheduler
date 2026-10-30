// The dev-only ops service: safety rules, service control (with fakes, so tests never stop real containers),
// live invariants against the test database, and the race endpoint against a real booking-api.
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Invariants, RaceResult } from '@ds/shared';
import { buildOpsApp } from '../src/app.js';
import { assertOpsEnabled } from '../src/guard.js';
import type { DockerControl } from '../src/docker.js';
import { unmanagedProcesses, type ProcessControl } from '../src/supervisor.js';
import { buildApp } from '../../booking-api/src/app.js';
import { materializeSlots } from '../../booking-api/src/materializer.js';
import { testDatabaseUrl } from '../../../test/test-db.js';

process.env.LOG_LEVEL = 'silent';
const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 60 });
const noHealth = { check: async () => ({ ok: true, checkedAt: '', dependencies: {} as never }), close: async () => {} };
const calls: string[] = [];
const fakeDocker: DockerControl = {
  status: async () => ({ up: true, healthy: true }),
  stop: async (n) => void calls.push(`stop ${n}`),
  start: async (n) => void calls.push(`start ${n}`),
};
const fakeProcesses: ProcessControl = {
  managed: true,
  status: async () => ({ up: true, healthy: true }),
  stop: async (n) => void calls.push(`stop ${n}`),
  start: async (n) => void calls.push(`start ${n}`),
  waitHealthy: async () => true,
  stopAll: async () => {},
};
let api: FastifyInstance;
let ops: FastifyInstance;
let consoleDoctor: string;

async function opsWith(processes: ProcessControl, apiUrl = 'http://127.0.0.1:1') {
  return buildOpsApp({ pool, docker: fakeDocker, processes, kafka: null, load: null, apiUrl, webOrigin: 'x' });
}

beforeAll(async () => {
  api = await buildApp({ pool, health: noHealth, webOrigin: 'x' });
  await api.listen({ port: 0, host: '127.0.0.1' });
  ops = await opsWith(fakeProcesses, `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`);
  // A doctor with open slots tomorrow+ and enough patients for a race.
  const d = await pool.query<{ id: string }>(
    `INSERT INTO doctors (name, specialty, clinic, area, lat, lng) VALUES ('Dr. Console', 'ENT', 'C', 'HSR Layout', 12.91, 77.64) RETURNING id`,
  );
  await pool.query(
    `INSERT INTO schedule_templates (doctor_id, weekday, start_local, end_local, slot_minutes, valid_from)
     SELECT $1, wd, '09:00', '13:00', 15, current_date - 1 FROM generate_series(1, 7) wd`,
    [d.rows[0].id],
  );
  consoleDoctor = d.rows[0].id;
  await materializeSlots(pool, { doctorIds: [d.rows[0].id], days: 5 });
  await pool.query(
    `INSERT INTO patients (name, phone) SELECT 'Racer ' || i, '+9177' || floor(random() * 1e8)::bigint FROM generate_series(1, 30) i`,
  );
});
afterAll(async () => {
  await ops.close();
  await api.close();
  await pool.end();
});

describe('safety', () => {
  it('refuses to start without OPS_ENABLED=1, or in production', () => {
    expect(() => assertOpsEnabled({})).toThrow(/dev-only/);
    expect(() => assertOpsEnabled({ OPS_ENABLED: '1', NODE_ENV: 'production' })).toThrow(/production/);
    expect(() => assertOpsEnabled({ OPS_ENABLED: '1' })).not.toThrow();
  });

  it('only acts on whitelisted names; postgres is never stoppable', async () => {
    expect((await ops.inject({ method: 'POST', url: '/ops/services/rm -rf/stop', payload: {} })).statusCode).toBe(404);
    expect((await ops.inject({ method: 'POST', url: '/ops/services/postgres/stop', payload: {} })).statusCode).toBe(403);
    expect((await ops.inject({ method: 'POST', url: '/ops/services/redis/stop', payload: {} })).statusCode).toBe(200);
    expect((await ops.inject({ method: 'POST', url: '/ops/services/api-1/start', payload: {} })).statusCode).toBe(200);
    expect(calls).toEqual(['stop redis', 'start api-1']);
  });

  it('processes are only controllable when the cluster is supervised', async () => {
    const plain = await opsWith(unmanagedProcesses);
    expect((await plain.inject({ method: 'POST', url: '/ops/services/api-1/stop', payload: {} })).statusCode).toBe(409);
    const list = (await plain.inject({ method: 'GET', url: '/ops/services' })).json();
    expect(list.find((s: { name: string }) => s.name === 'postgres')).toMatchObject({ controllable: false });
    await plain.close();
  });
});

describe('invariants', () => {
  it('are 0 on a healthy database, and catch planted violations', async () => {
    const clean = (await ops.inject({ method: 'GET', url: '/ops/invariants' })).json<Invariants>();
    expect([clean.doubleBookings, clean.patientOverlaps, clean.holdsInTimeOff]).toEqual([0, 0, 0]);

    // The database forbids double bookings outright (EXCLUDE), so those can't be planted. Holds inside time off
    // and unswept expired holds can, so the canaries are proven to work.
    // Planted on this file's own doctor and fresh patients, so other test files' data can't interfere.
    const slots = await pool.query<{ id: string; doctor_id: string; during: string }>(
      `SELECT id, doctor_id, during FROM slots WHERE doctor_id = $1 AND status = 'open' AND kind = 'base'
          AND lower(during) > now() + interval '1 day' ORDER BY lower(during) LIMIT 2`,
      [consoleDoctor],
    );
    const fresh = await pool.query<{ id: string }>(
      `INSERT INTO patients (name, phone) SELECT 'Planted ' || i, '+9178' || floor(random() * 1e8)::bigint FROM generate_series(1, 2) i RETURNING id`,
    );
    const slot = { rows: [slots.rows[0]] };
    const p = { rows: [fresh.rows[0]] };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE slots SET status = 'held', hold_id = gen_random_uuid(), hold_patient_id = $2, hold_expires_at = now() + interval '5 minutes' WHERE id = $1`,
        [slot.rows[0].id, p.rows[0].id],
      );
      await client.query(`INSERT INTO schedule_exceptions (doctor_id, during, kind) VALUES ($1, $2, 'blocked')`, [slot.rows[0].doctor_id, slot.rows[0].during]);
      await client.query(
        `UPDATE slots SET status = 'held', hold_id = gen_random_uuid(), hold_patient_id = $1, hold_expires_at = now() - interval '5 minutes'
          WHERE id = $2`,
        [fresh.rows[1].id, slots.rows[1].id],
      );
      // Read through the same transaction's view: the check is just SQL.
      const { checkInvariants } = await import('../src/invariants.js');
      const dirty = await checkInvariants(client as unknown as pg.Pool);
      expect(dirty.holdsInTimeOff).toBeGreaterThanOrEqual(1);
      expect(dirty.expiredHoldsNotSwept).toBeGreaterThanOrEqual(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('race', () => {
  it('through the API: exactly one of 20 racers holds the slot (and is released afterwards)', async () => {
    // Other test files may leave live holds in the shared test DB, so compare before/after, not against 0.
    const liveHolds = async () =>
      (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM slots WHERE status = 'held' AND hold_expires_at > now()`)).rows[0].n;
    const before = await liveHolds();
    const r = (await ops.inject({ method: 'POST', url: '/ops/race', payload: { mode: 'api', racers: 20 } })).json<RaceResult>();
    expect([r.held, r.rejected + r.other]).toEqual([1, 19]);
    expect(await liveHolds()).toBe(before); // the winner's hold was released
  });

  it('naive check-then-act: every racer told "yes" overwrote the same row', async () => {
    // HOW MANY are told "yes" depends on timing (60 of 100 on the live stack; on a busy CI machine maybe 1), so
    // the test asserts only what is deterministic: each "yes" is one overwrite of the single row.
    const r = (await ops.inject({ method: 'POST', url: '/ops/race', payload: { mode: 'naive', racers: 20 } })).json<RaceResult>();
    expect(r.naiveToldYes).toBeGreaterThanOrEqual(1);
    expect(r.overwrites).toBe(r.naiveToldYes);
  });
});
