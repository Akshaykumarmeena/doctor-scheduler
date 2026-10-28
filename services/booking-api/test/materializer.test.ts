import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { materializeSlots } from '../src/materializer.js';
import { testDatabaseUrl } from '../../../test/test-db.js';

const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
let doctorId: string;

// Monday 2 Nov 2026, 00:00 IST. Fixed so the test does not depend on today's date.
const FROM = new Date('2026-11-01T18:30:00Z');

beforeAll(async () => {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO doctors (name, specialty, clinic, area, lat, lng, tz)
     VALUES ('Dr. Materializer', 'ENT', 'Test Clinic', 'Jayanagar', 12.93, 77.58, 'Asia/Kolkata') RETURNING id`,
  );
  doctorId = rows[0].id;
  // Mon-Fri 09:00-13:00 local, 15-minute slots => 16 slots per weekday.
  await pool.query(
    `INSERT INTO schedule_templates (doctor_id, weekday, start_local, end_local, slot_minutes, valid_from)
     SELECT $1, wd, '09:00', '13:00', 15, '2026-01-01' FROM generate_series(1, 5) AS wd`,
    [doctorId],
  );
});
beforeEach(() => pool.query('DELETE FROM slots WHERE doctor_id = $1', [doctorId]));
afterAll(async () => {
  await pool.query('DELETE FROM doctors WHERE id = $1', [doctorId]);
  await pool.end();
});

const opts = () => ({ days: 14, from: FROM, doctorIds: [doctorId] });
const count = async () =>
  (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM slots WHERE doctor_id = $1', [doctorId])).rows[0].n;

describe('materializeSlots', () => {
  it('creates 16 slots per weekday for 14 days (10 weekdays)', async () => {
    expect(await materializeSlots(pool, opts())).toBe(160);
    expect(await count()).toBe(160);
  });

  it('is idempotent: a second run inserts nothing', async () => {
    await materializeSlots(pool, opts());
    expect(await materializeSlots(pool, opts())).toBe(0);
    expect(await count()).toBe(160);
  });

  it('stores UTC: 09:00 Asia/Kolkata is 03:30Z, and slots are 15 minutes', async () => {
    await materializeSlots(pool, opts());
    const { rows } = await pool.query<{ start: string; minutes: number }>(
      `SELECT to_char(lower(during) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS start,
              extract(epoch FROM upper(during) - lower(during))::int / 60 AS minutes
         FROM slots WHERE doctor_id = $1 ORDER BY lower(during) LIMIT 1`,
      [doctorId],
    );
    expect(rows[0]).toEqual({ start: '2026-11-02T03:30Z', minutes: 15 });
  });

  it('skips slots that overlap an exception (a day of leave)', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO schedule_exceptions (doctor_id, during, kind)
       VALUES ($1, tstzrange('2026-11-03 00:00+05:30', '2026-11-04 00:00+05:30'), 'leave') RETURNING id`,
      [doctorId],
    );
    try {
      expect(await materializeSlots(pool, opts())).toBe(144);
    } finally {
      await pool.query('DELETE FROM schedule_exceptions WHERE id = $1', [rows[0].id]);
    }
  });
});
