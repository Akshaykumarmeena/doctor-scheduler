// The SSE heartbeat the browser can see (Phase 7): "hello" right after connecting. Pages use it to detect a stream
// that a proxy holds back, and fall back to polling (apps/web/app/live.tsx).
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { LiveHub } from '../src/live/hub.js';
import { testDatabaseUrl } from '../../../test/test-db.js';

process.env.LOG_LEVEL = 'silent';
const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
const noHealth = { check: async () => ({ ok: true, checkedAt: '', dependencies: {} as never }), close: async () => {} };
const hub = new LiveHub(process.env.REDIS_URL ?? 'redis://localhost:6379');
let app: FastifyInstance;
let baseUrl: string;
let patientId: string;

beforeAll(async () => {
  app = await buildApp({ pool, health: noHealth, hub, webOrigin: 'x' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  patientId = (
    await pool.query<{ id: string }>(`INSERT INTO patients (name, phone) VALUES ('Heartbeat', '+9179' || floor(random() * 1e8)::bigint) RETURNING id`)
  ).rows[0].id;
});
afterAll(async () => {
  await app.close();
  await hub.close();
  await pool.end();
});

describe('SSE heartbeat', () => {
  it('sends a browser-visible "hello" message immediately after connecting', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${baseUrl}/patients/${patientId}/stream`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const t0 = Date.now();
    while (!text.includes('data: hello') && Date.now() - t0 < 2000) text += decoder.decode((await reader.read()).value);
    ctrl.abort();
    expect(text).toContain(': connected');
    expect(text).toContain('data: hello'); // a plain "message" frame: EventSource's onmessage fires
  });
});
