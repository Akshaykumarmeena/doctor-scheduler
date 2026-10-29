// Background workers:
//   - outbox relay:      Postgres outbox -> Redpanda topic "appointments" (Phase 2)
//   - search-indexer:    "appointments" -> OpenSearch "doctors" read model (Phase 3)
//   - live-fanout:       "appointments" -> Redis doctor:<id> -> SSE in the browser (Phase 4)
//   - notifier:          "appointments" -> patient inbox (Phase 4)
//   - waitlist-matcher:  "appointments" -> offer freed slots to the waitlist (Phase 4)
//   - reminders:         every minute, Postgres -> patient inbox (Phase 4)
// Each consumer is its own GROUP: Kafka tracks a separate offset for each, so each sees every event, and a slow or
// broken one (say OpenSearch is down) never holds the others back.
import { Kafka, logLevel, type Consumer, type EachBatchPayload } from 'kafkajs';
import { Redis } from 'ioredis';
import pg from 'pg';
import { TOPIC, relayOnce, type EventPublisher } from './outbox-relay.js';
import { aliasExists, handleEvents, reindexAll } from './search/indexer.js';
import { DOCTORS_ALIAS } from './search/mapping.js';
import { fanOut } from './live-fanout.js';
import { handleNotifierEvents } from './notifier.js';
import { handleMatcherEvents } from './waitlist/matcher.js';
import { bookingApiClient } from './waitlist/booking-api-client.js';
import { sendDueReminders } from './reminders.js';
import type { RawMessage } from './events.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://scheduler:scheduler@localhost:5432/scheduler';
const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
const osUrl = process.env.OPENSEARCH_URL ?? 'http://localhost:9200';
const apiUrl = process.env.API_URL ?? 'http://localhost:4000';
const POLL_MS = 1000;
const REMINDER_EVERY_MS = 60_000;

const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
const kafka = new Kafka({ clientId: 'workers', brokers, logLevel: logLevel.WARN });
// idempotent: the broker drops duplicates caused by the producer's own retries.
const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1 });
redis.on('error', () => {}); // live updates are best effort; Postgres is the record
const publish = (channel: string, message: string) => redis.publish(channel, message);
const consumers: Consumer[] = [];

const publisher: EventPublisher = {
  async publish(topic, messages) {
    await producer.send({ topic, messages });
  },
};

async function ensureTopic() {
  const admin = kafka.admin();
  await admin.connect();
  // 6 partitions: doctor events spread across them, each doctor's events stay in one.
  const created = await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 6, replicationFactor: 1 }] });
  await admin.disconnect();
  if (created) console.log(`created topic ${TOPIC}`);
}

let stopping = false;

async function runOutboxRelay() {
  await producer.connect();
  console.log(`outbox relay: publishing to ${TOPIC} every ${POLL_MS} ms`);
  while (!stopping) {
    try {
      let n: number;
      // Drain the backlog quickly, then sleep.
      do {
        n = await relayOnce(pool, publisher);
        if (n > 0) console.log(`outbox relay: published ${n} event(s)`);
      } while (n > 0 && !stopping);
    } catch (err) {
      console.error(`outbox relay failed, will retry: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * Runs one consumer group. Offsets are resolved only after `handle` succeeded: at-least-once. If it throws,
 * kafkajs retries the batch, so every handler must be idempotent.
 */
async function runConsumer(groupId: string, fromBeginning: boolean, handle: (messages: RawMessage[]) => Promise<string | null>) {
  const consumer = kafka.consumer({ groupId });
  consumers.push(consumer);
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning });
  await consumer.run({
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }: EachBatchPayload) => {
      const summary = await handle(
        batch.messages.map((m) => ({ key: m.key?.toString() ?? null, value: m.value?.toString() ?? null })),
      );
      for (const m of batch.messages) resolveOffset(m.offset);
      await commitOffsetsIfNecessary();
      await heartbeat();
      if (summary) console.log(`${groupId}: partition ${batch.partition}, offset ${batch.lastOffset()}: ${summary}`);
    },
  });
  console.log(`${groupId}: consuming ${TOPIC}`);
}

async function runSearchIndexer() {
  if (!(await aliasExists(osUrl, DOCTORS_ALIAS))) {
    console.log(`search-indexer: alias "${DOCTORS_ALIAS}" missing, building it from Postgres`);
    const r = await reindexAll(pool, osUrl, DOCTORS_ALIAS);
    console.log(`search-indexer: indexed ${r.count} doctors into ${r.index}`);
  }
  await runConsumer('search-indexer', true, async (messages) => {
    const n = await handleEvents(pool, osUrl, DOCTORS_ALIAS, messages);
    return n > 0 ? `reindexed ${n} doctor(s)` : null;
  });
}

async function runReminders() {
  console.log(`reminders: checking every ${REMINDER_EVERY_MS / 1000} s`);
  while (!stopping) {
    try {
      const n = await sendDueReminders(pool, publish);
      if (n > 0) console.log(`reminders: sent ${n}`);
    } catch (err) {
      console.error(`reminders failed, will retry: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, REMINDER_EVERY_MS));
  }
}

const api = bookingApiClient(apiUrl);
const started = (name: string) => (err: unknown) => console.error(`${name} failed to start: ${(err as Error).message}`);

async function main() {
  await ensureTopic();
  // Independent loops: if OpenSearch or Redis is down, the others keep going.
  await Promise.all([
    runOutboxRelay(),
    runSearchIndexer().catch(started('search-indexer')),
    // Live updates are only useful from now on: a new group starts at the latest offset.
    runConsumer('live-fanout', false, async (m) => `published ${await fanOut(publish, m)} live update(s)`).catch(started('live-fanout')),
    runConsumer('notifier', true, async (m) => {
      const n = await handleNotifierEvents(pool, publish, m);
      return n > 0 ? `created ${n} notification(s)` : null;
    }).catch(started('notifier')),
    runConsumer('waitlist-matcher', true, async (m) => {
      const n = await handleMatcherEvents(pool, api, publish, m);
      return n > 0 ? `made ${n} offer(s)` : null;
    }).catch(started('waitlist-matcher')),
    runReminders(),
  ]);
}

const shutdown = async () => {
  stopping = true;
  await Promise.all(consumers.map((c) => c.disconnect().catch(() => {})));
  await producer.disconnect().catch(() => {});
  redis.disconnect();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
