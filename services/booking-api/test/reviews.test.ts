// Phase 8: reviews and the fair (Bayesian) rating. Who may review, once per visit, the math, concurrent reviews,
// and the doctor.rating_changed event refreshing search.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DoctorReviews, ReviewCreated, SearchResponse } from '@ds/shared';
import { buildApp } from '../src/app.js';
import { testDatabaseUrl } from '../../../test/test-db.js';
import { handleEvents, reindexAll } from '../../workers/src/search/indexer.js';
import { os } from '../../workers/src/search/opensearch.js';

process.env.LOG_LEVEL = 'silent';
const OS = process.env.OPENSEARCH_URL ?? 'http://localhost:9200';
const ALIAS = `test_reviews_${Date.now()}`;
const SPECIALTY = `Review-${randomUUID().slice(0, 8)}`;
const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 20 });
const noHealth = { check: async () => ({ ok: true, checkedAt: '', dependencies: {} as never }), close: async () => {} };
let app: FastifyInstance;

const review = (appointmentId: string, body: object, key = randomUUID()) =>
  app.inject({ method: 'POST', url: `/appointments/${appointmentId}/review`, payload: body, headers: { 'idempotency-key': key } });

async function doctor(rating: number) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO doctors (name, specialty, clinic, area, lat, lng, rating)
     VALUES ('Dr. Review', $1, 'C', 'Jayanagar', 12.93, 77.58, $2) RETURNING id`,
    [SPECIALTY, rating],
  );
  return rows[0].id;
}
const newPatient = async (name = 'Asha Rao') =>
  (await pool.query<{ id: string }>(`INSERT INTO patients (name, phone) VALUES ($1, '+9175' || floor(random() * 1e8)::bigint) RETURNING id`, [name]))
    .rows[0].id;

let visitNo = 0;
/** A past visit with this status (inserted directly: the API never books the past). Each one at its own time. */
async function visit(doctorId: string, patientId: string, status: 'completed' | 'confirmed' | 'no_show' = 'completed') {
  const n = ++visitNo;
  const slot = await pool.query<{ id: string }>(
    `INSERT INTO slots (doctor_id, during, status)
     VALUES ($1, tstzrange(now() - make_interval(hours => 2 + $2), now() - make_interval(hours => 2 + $2) + interval '15 minutes'), 'open')
     RETURNING id`,
    [doctorId, n],
  );
  const appt = await pool.query<{ id: string }>(
    `INSERT INTO appointments (slot_id, doctor_id, patient_id, visit_type, status, idempotency_key)
     VALUES ($1, $2, $3, 'in_person', $4, gen_random_uuid()::text) RETURNING id`,
    [slot.rows[0].id, doctorId, patientId, status],
  );
  await pool.query(`UPDATE slots SET status = 'booked', appointment_id = $2 WHERE id = $1`, [slot.rows[0].id, appt.rows[0].id]);
  return appt.rows[0].id;
}
const ratingOf = async (doctorId: string) =>
  (await pool.query<{ rating: number; count: number; sum: number; prior: number | null }>(
    'SELECT rating::float AS rating, rating_count AS count, rating_sum AS sum, rating_prior::float AS prior FROM doctors WHERE id = $1',
    [doctorId],
  )).rows[0];

beforeAll(async () => {
  app = await buildApp({ pool, health: noHealth, webOrigin: 'x', opensearchUrl: OS, searchIndex: ALIAS });
});
afterAll(async () => {
  await app.close();
  const alias = await os<Record<string, unknown>>(OS, 'GET', `/_alias/${ALIAS}`);
  for (const index of alias.status === 200 ? Object.keys(alias.body) : []) await os(OS, 'DELETE', `/${index}`);
  await pool.end();
});

describe('who may review', () => {
  it('only the patient of a completed visit, once; a retry with the same key replays the answer', async () => {
    const d = await doctor(4.0);
    const patient = await newPatient();
    const done = await visit(d, patient);

    expect((await review(randomUUID(), { patientId: patient, stars: 5 })).statusCode).toBe(404);
    expect((await review(done, { patientId: await newPatient(), stars: 5 })).json().error).toBe('not_your_appointment'); // 403
    expect((await review(await visit(d, patient, 'confirmed'), { patientId: patient, stars: 5 })).statusCode).toBe(409);
    expect((await review(await visit(d, patient, 'no_show'), { patientId: patient, stars: 1 })).json().error).toBe('appointment_not_completed');
    expect((await review(done, { patientId: patient, stars: 6 })).statusCode).toBe(400);

    const key = randomUUID();
    const first = await review(done, { patientId: patient, stars: 5, comment: '  Very kind  ' }, key);
    expect(first.statusCode).toBe(201);
    expect(first.json<ReviewCreated>()).toMatchObject({ stars: 5, comment: 'Very kind', doctorRating: { fair: 4.0, count: 1 } });

    const retry = await review(done, { patientId: patient, stars: 5, comment: '  Very kind  ' }, key);
    expect([retry.statusCode, retry.headers['idempotent-replayed']]).toEqual([201, 'true']);
    expect(retry.json()).toEqual(first.json());

    const again = await review(done, { patientId: patient, stars: 1 }); // a new key: a second review, refused
    expect([again.statusCode, again.json().error]).toEqual([409, 'already_reviewed']);
    expect(await ratingOf(d)).toMatchObject({ count: 1, sum: 5 });
  });
});

describe('fair rating', () => {
  it('2 five-star reviews do not beat 800 reviews averaging 4.7', async () => {
    const newcomer = await doctor(4.0);
    for (let i = 0; i < 2; i++) {
      const p = await newPatient();
      expect((await review(await visit(newcomer, p), { patientId: p, stars: 5 })).statusCode).toBe(201);
    }
    // (20 × 4.0 + 10) / (20 + 2) = 4.09: the prior still dominates. A plain average would say 5.0.
    expect(await ratingOf(newcomer)).toMatchObject({ rating: 4.1, count: 2, sum: 10, prior: 4.0 });

    const veteran = await doctor(4.0);
    // 799 earlier reviews summing 3,755 (avg 4.70) as if already recorded, then one real review through the API.
    await pool.query('UPDATE doctors SET rating_prior = 4.0, rating_count = 799, rating_sum = 3755 WHERE id = $1', [veteran]);
    const p = await newPatient();
    const res = (await review(await visit(veteran, p), { patientId: p, stars: 5 })).json<ReviewCreated>();
    // (20 × 4.0 + 3,760) / (20 + 800) = 4.68: the real average dominates.
    expect(res.doctorRating).toEqual({ fair: 4.7, count: 800 });
    expect(res.doctorRating.fair).toBeGreaterThan((await ratingOf(newcomer)).rating);
  });

  it('a doctor with no rating starts from the platform mean', async () => {
    const unrated = await doctor(0);
    const p = await newPatient();
    await review(await visit(unrated, p), { patientId: p, stars: 3 });
    const mean = (await pool.query<{ m: number }>('SELECT round(avg(rating), 1)::float AS m FROM doctors WHERE rating > 0 AND id <> $1', [unrated])).rows[0].m;
    const r = await ratingOf(unrated);
    expect(r.prior).toBe(mean);
    expect(r.rating).toBe(Math.round(((20 * mean + 3) / 21) * 10) / 10);
  });

  it('concurrent reviews of one doctor all count (the row lock serializes the recompute)', async () => {
    const d = await doctor(4.0);
    const visits = await Promise.all(Array.from({ length: 10 }, async () => {
      const p = await newPatient();
      return { p, a: await visit(d, p) };
    }));
    const results = await Promise.all(visits.map(({ p, a }, i) => review(a, { patientId: p, stars: (i % 5) + 1 })));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    // stars 1..5 twice = 30
    expect(await ratingOf(d)).toMatchObject({ count: 10, sum: 30, rating: Math.round(((80 + 30) / 30) * 10) / 10 });
  });
});

describe('reading reviews', () => {
  it('fair rating, distribution and the latest reviews with first names only', async () => {
    const d = await doctor(4.5);
    for (const [name, stars] of [['Ravi Kumar', 4], ['Meera Iyer', 5], ['Arjun Shah', 5]] as const) {
      const p = await newPatient(name);
      await review(await visit(d, p), { patientId: p, stars, comment: `${stars} stars` });
    }
    const r = (await app.inject({ method: 'GET', url: `/doctors/${d}/reviews?limit=2` })).json<DoctorReviews>();
    expect(r).toMatchObject({ fair: 4.5, count: 3, distribution: { '1': 0, '2': 0, '3': 0, '4': 1, '5': 2 } });
    expect(r.reviews.map((x) => x.patientFirstName)).toEqual(['Arjun', 'Meera']); // newest first, limit 2
    expect(JSON.stringify(r)).not.toContain('Shah');
    expect((await app.inject({ method: 'GET', url: `/doctors/${randomUUID()}/reviews` })).statusCode).toBe(404);
  });
});

describe('search follows the rating', () => {
  it('a review emits doctor.rating_changed, and the indexer refreshes rating and count', async () => {
    const d = await doctor(4.0);
    await reindexAll(pool, OS, ALIAS);
    const p = await newPatient();
    await review(await visit(d, p), { patientId: p, stars: 1 });

    const { rows } = await pool.query<{ event_type: string; payload: { rating: number; ratingCount: number } }>(
      `SELECT event_type, payload FROM outbox WHERE doctor_id = $1 ORDER BY id DESC LIMIT 1`,
      [d],
    );
    expect(rows[0]).toEqual({ event_type: 'doctor.rating_changed', payload: expect.objectContaining({ rating: 3.9, ratingCount: 1 }) });

    const event = { key: d, value: JSON.stringify({ eventId: 'r1', doctorId: d, eventType: 'doctor.rating_changed' }) };
    expect(await handleEvents(pool, OS, ALIAS, [event])).toBe(1);
    await os(OS, 'POST', `/${ALIAS}/_refresh`);
    const res = (await app.inject({ method: 'GET', url: `/search?specialty=${SPECIALTY}&q=review` })).json<SearchResponse>();
    expect(res.results.find((x) => x.doctor.id === d)?.doctor).toMatchObject({ rating: 3.9, ratingCount: 1 });
  });
});
