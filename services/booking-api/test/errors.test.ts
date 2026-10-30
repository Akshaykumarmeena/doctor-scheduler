// The API's error shape: client mistakes are 4xx with { error, message }, never a 500.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { testDatabaseUrl } from '../../../test/test-db.js';

process.env.LOG_LEVEL = 'silent';
const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
const noHealth = { check: async () => ({ ok: true, checkedAt: '', dependencies: {} as never }), close: async () => {} };
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ pool, health: noHealth, webOrigin: 'x' });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('client errors stay client errors', () => {
  it('an empty JSON body is a 400, not a 500 (found by the Phase 6 load test)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/appointments/00000000-0000-0000-0000-000000000000/cancel',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-empty-body' },
      payload: '',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('malformed JSON is a 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/holds',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-bad-json' },
      payload: '{"slotId": ',
    });
    expect(res.statusCode).toBe(400);
  });
});
