// Search end to end against a real OpenSearch: Postgres -> documents -> index (behind an alias) -> /search.
// Uses its own alias so it never touches the dev "doctors" index.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SearchResponse } from '@ds/shared';
import { buildApp } from '../src/app.js';
import { testDatabaseUrl } from '../../../test/test-db.js';
import { handleEvents, reindexAll } from '../../workers/src/search/indexer.js';
import { os } from '../../workers/src/search/opensearch.js';

process.env.LOG_LEVEL = 'silent';
const OS = process.env.OPENSEARCH_URL ?? 'http://localhost:9200';
const ALIAS = `test_doctors_${Date.now()}`;
const SPECIALTY = `Test-${randomUUID().slice(0, 8)}`; // isolates this file's doctors from everything else
const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
const noHealth = { check: async () => ({ ok: true, checkedAt: '', dependencies: {} as never }), close: async () => {} };
let app: FastifyInstance;
const ids: Record<'kora' | 'white' | 'kannadaKora', string> = { kora: '', white: '', kannadaKora: '' };

// Mon 7 Jan 2030, 09:00 IST
const MONDAY = '2030-01-07';
const at = (i: number) => new Date(Date.UTC(2030, 0, 7, 3, 30 + 15 * i)).toISOString();

async function doctor(name: string, area: string, lat: number, lng: number, languages: string[], rating: number) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO doctors (name, specialty, clinic, area, lat, lng, languages, rating)
     VALUES ($1, $2, 'Test Clinic', $3, $4, $5, $6, $7) RETURNING id`,
    [name, SPECIALTY, area, lat, lng, languages, rating],
  );
  await pool.query(
    `INSERT INTO slots (doctor_id, during)
     SELECT $1, tstzrange(t, t + interval '15 minutes') FROM unnest($2::timestamptz[]) t`,
    [rows[0].id, [0, 1].map(at)],
  );
  return rows[0].id;
}

const search = async (qs: string) =>
  (await app.inject({ method: 'GET', url: `/search?specialty=${SPECIALTY}&${qs}` })).json<SearchResponse>();

beforeAll(async () => {
  ids.kora = await doctor('Dr. Anil Rao', 'Koramangala', 12.9352, 77.6245, ['English', 'Hindi'], 4.8);
  ids.white = await doctor('Dr. Priya Nair', 'Whitefield', 12.9698, 77.75, ['English', 'Malayalam'], 4.1);
  ids.kannadaKora = await doctor('Dr. Kavya Gowda', 'Koramangala', 12.936, 77.625, ['English', 'Kannada'], 3.6);
  await reindexAll(pool, OS, ALIAS);
  app = await buildApp({ pool, health: noHealth, webOrigin: 'x', opensearchUrl: OS, searchIndex: ALIAS });
});

afterAll(async () => {
  await app.close();
  const alias = await os<Record<string, unknown>>(OS, 'GET', `/_alias/${ALIAS}`);
  for (const index of alias.status === 200 ? Object.keys(alias.body) : []) await os(OS, 'DELETE', `/${index}`);
  await pool.end();
});

describe('search', () => {
  it('filters by specialty and language, and finds a typo in the name', async () => {
    expect((await search('language=Kannada')).results.map((r) => r.doctor.id)).toEqual([ids.kannadaKora]);
    expect((await search('q=priyaa')).results.map((r) => r.doctor.id)).toEqual([ids.white]);
    expect((await search('q=gow')).results.map((r) => r.doctor.id)).toEqual([ids.kannadaKora]); // prefix, as you type
  });

  it('near Koramangala within 3 km excludes Whitefield and sorts by distance', async () => {
    const res = await search('lat=12.9352&lng=77.6245&radiusKm=3&sort=distance');
    expect(res.results.map((r) => r.doctor.id)).toEqual([ids.kora, ids.kannadaKora]);
    expect(res.results[0].distanceKm).toBe(0);
  });

  it('ranks by rating when asked', async () => {
    expect((await search('sort=rating')).results.map((r) => r.doctor.rating)).toEqual([4.8, 4.1, 3.6]);
  });

  it('an appointment event updates the read model: a fully booked day stops matching that date', async () => {
    expect((await search(`date=${MONDAY}`)).results.map((r) => r.doctor.id)).toContain(ids.white);

    // Book both of Dr. Nair's Monday slots directly, then deliver the event the outbox relay would publish.
    await pool.query(`INSERT INTO patients (name, phone) VALUES ('S', $1) ON CONFLICT DO NOTHING`, [`+9172${Date.now() % 1e8}`]);
    const patient = (await pool.query<{ id: string }>('SELECT id FROM patients LIMIT 1')).rows[0].id;
    const slots = (await pool.query<{ id: string }>('SELECT id FROM slots WHERE doctor_id = $1', [ids.white])).rows;
    for (const s of slots) {
      const a = await pool.query<{ id: string }>(
        `INSERT INTO appointments (slot_id, doctor_id, patient_id, visit_type, idempotency_key)
         VALUES ($1, $2, $3, 'in_person', gen_random_uuid()::text) RETURNING id`,
        [s.id, ids.white, patient],
      );
      await pool.query(`UPDATE slots SET status = 'booked', appointment_id = $2 WHERE id = $1`, [s.id, a.rows[0].id]);
    }
    const event = { key: ids.white, value: JSON.stringify({ eventId: '1', doctorId: ids.white, eventType: 'appointment.booked' }) };
    // Delivered twice (at-least-once): same result.
    expect(await handleEvents(pool, OS, ALIAS, [event, event])).toBe(1);
    await os(OS, 'POST', `/${ALIAS}/_refresh`);

    const res = await search(`date=${MONDAY}`);
    expect(res.results.map((r) => r.doctor.id)).not.toContain(ids.white);
    const nair = (await search('q=nair')).results[0];
    expect([nair.openSlots, nair.nextAvailable]).toEqual([0, null]);
  });

  it('a full reindex swaps the alias to a new index and drops the old one', async () => {
    const before = Object.keys((await os<Record<string, unknown>>(OS, 'GET', `/_alias/${ALIAS}`)).body);
    const r = await reindexAll(pool, OS, ALIAS);
    const after = Object.keys((await os<Record<string, unknown>>(OS, 'GET', `/_alias/${ALIAS}`)).body);
    expect(after).toEqual([r.index]);
    expect(r.replaced).toEqual(before);
    expect((await os(OS, 'HEAD', `/${before[0]}`)).status).toBe(404);
  });

  it('returns 503 when OpenSearch is unreachable', async () => {
    const down = await buildApp({ pool, health: noHealth, webOrigin: 'x', opensearchUrl: 'http://127.0.0.1:1', searchIndex: ALIAS });
    const res = await down.inject({ method: 'GET', url: '/search?q=x' });
    await down.close();
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('search_unavailable');
  });
});
