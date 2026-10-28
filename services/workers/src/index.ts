// Background workers. Phase 2: the outbox relay (Postgres -> Redpanda).
// Later: search indexer (Redpanda -> OpenSearch), waitlist matcher.
import { Kafka, logLevel } from 'kafkajs';
import pg from 'pg';
import { TOPIC, relayOnce, type EventPublisher } from './outbox-relay.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://scheduler:scheduler@localhost:5432/scheduler';
const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
const POLL_MS = 1000;

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const kafka = new Kafka({ clientId: 'outbox-relay', brokers, logLevel: logLevel.WARN });
// idempotent: the broker drops duplicates caused by the producer's own retries.
const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });

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
async function main() {
  await ensureTopic();
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

const shutdown = async () => {
  stopping = true;
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
