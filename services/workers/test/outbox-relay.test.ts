import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { relayOnce, type EventPublisher } from '../src/outbox-relay.js';
import { testDatabaseUrl } from '../../../test/test-db.js';

const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
const DOCTOR = '00000000-0000-0000-0000-00000000aaaa';
afterAll(() => pool.end());

type Sent = Parameters<EventPublisher['publish']>[1];
function fakePublisher(fail = false) {
  const sent: Sent = [];
  const publisher: EventPublisher = {
    async publish(_topic, messages) {
      if (fail) throw new Error('broker down');
      sent.push(...messages);
    },
  };
  return { publisher, sent };
}

beforeEach(async () => {
  await pool.query('DELETE FROM outbox');
  await pool.query(
    `INSERT INTO outbox (doctor_id, aggregate_id, event_type, payload)
     SELECT $1, gen_random_uuid(), 'appointment.booked', jsonb_build_object('n', i) FROM generate_series(1, 3) i`,
    [DOCTOR],
  );
});

describe('relayOnce', () => {
  it('publishes unpublished rows in order, keyed by doctor_id, and marks them published', async () => {
    const { publisher, sent } = fakePublisher();
    expect(await relayOnce(pool, publisher)).toBe(3);
    expect(sent.map((m) => JSON.parse(m.value).payload.n)).toEqual([1, 2, 3]);
    expect(sent.every((m) => m.key === DOCTOR && m.headers['event-type'] === 'appointment.booked')).toBe(true);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL');
    expect(rows[0].n).toBe(0);
  });

  it('does not publish the same rows twice', async () => {
    const { publisher, sent } = fakePublisher();
    await relayOnce(pool, publisher);
    expect(await relayOnce(pool, publisher)).toBe(0);
    expect(sent).toHaveLength(3);
  });

  it('leaves rows unpublished when the broker is down, so the next tick retries them', async () => {
    await expect(relayOnce(pool, fakePublisher(true).publisher)).rejects.toThrow('broker down');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL');
    expect(rows[0].n).toBe(3);
    expect(await relayOnce(pool, fakePublisher().publisher)).toBe(3);
  });

  it('two relays at once never publish the same row (SKIP LOCKED)', async () => {
    const a = fakePublisher();
    const b = fakePublisher();
    const [na, nb] = await Promise.all([relayOnce(pool, a.publisher, 2), relayOnce(pool, b.publisher, 2)]);
    expect(na + nb).toBe(3);
    const ids = [...a.sent, ...b.sent].map((m) => JSON.parse(m.value).eventId);
    expect(new Set(ids).size).toBe(3);
  });
});
