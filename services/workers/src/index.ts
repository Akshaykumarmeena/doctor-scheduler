// Background workers:
//   - outbox relay:   Postgres outbox -> Redpanda topic "appointments" (Phase 2)
//   - search indexer: Redpanda "appointments" -> OpenSearch "doctors" read model (Phase 3)
// Later: waitlist matcher, notifier.
import { Kafka, logLevel } from 'kafkajs';
import pg from 'pg';
import { TOPIC, relayOnce, type EventPublisher } from './outbox-relay.js';
import { aliasExists, handleEvents, reindexAll } from './search/indexer.js';
import { DOCTORS_ALIAS } from './search/mapping.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://scheduler:scheduler@localhost:5432/scheduler';
const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
const osUrl = process.env.OPENSEARCH_URL ?? 'http://localhost:9200';
const POLL_MS = 1000;

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const kafka = new Kafka({ clientId: 'workers', brokers, logLevel: logLevel.WARN });
// idempotent: the broker drops duplicates caused by the producer's own retries.
const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
// A consumer GROUP: Kafka remembers how far "search-indexer" has read (its committed offset per partition).
// Run two copies and the partitions are split between them; stop both and they resume where they left off.
const consumer = kafka.consumer({ groupId: 'search-indexer' });

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

async function runSearchIndexer() {
  if (!(await aliasExists(osUrl, DOCTORS_ALIAS))) {
    console.log(`search indexer: alias "${DOCTORS_ALIAS}" missing, building it from Postgres`);
    const r = await reindexAll(pool, osUrl, DOCTORS_ALIAS);
    console.log(`search indexer: indexed ${r.count} doctors into ${r.index}`);
  }
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
  await consumer.run({
    // We resolve offsets ourselves, only after OpenSearch accepted the writes: at-least-once.
    // If indexing throws, kafkajs retries the batch; nothing is skipped.
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
      const n = await handleEvents(
        pool,
        osUrl,
        DOCTORS_ALIAS,
        batch.messages.map((m) => ({ key: m.key?.toString() ?? null, value: m.value?.toString() ?? null })),
      );
      for (const m of batch.messages) resolveOffset(m.offset);
      await commitOffsetsIfNecessary();
      await heartbeat();
      console.log(
        `search indexer: partition ${batch.partition}, ${batch.messages.length} event(s) -> reindexed ${n} doctor(s), ` +
          `offset ${batch.lastOffset()}`,
      );
    },
  });
  console.log(`search indexer: consuming ${TOPIC} as group "search-indexer"`);
}

async function main() {
  await ensureTopic();
  // Independent loops: if OpenSearch is down, the relay keeps publishing (and vice versa).
  await Promise.all([
    runOutboxRelay(),
    runSearchIndexer().catch((err) => console.error(`search indexer failed to start: ${(err as Error).message}`)),
  ]);
}

const shutdown = async () => {
  stopping = true;
  await consumer.disconnect().catch(() => {});
  await producer.disconnect().catch(() => {});
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
