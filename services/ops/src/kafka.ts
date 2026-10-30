// The console's two views into Kafka:
//   - a live feed of every event (its own consumer group "ops-console", starting at the latest offset: history
//     isn't interesting on a live screen), kept in a small ring buffer for clients that connect later
//   - consumer lag per group and partition = latest offset - committed offset ("how far behind is each reader?")
import { Kafka, logLevel } from 'kafkajs';
import type { ConsumerLag } from '@ds/shared';

export const TOPIC = 'appointments';
export const GROUPS = ['search-indexer', 'live-fanout', 'notifier', 'waitlist-matcher'] as const;

export interface FeedEvent {
  offset: string;
  partition: number;
  eventType: string;
  doctorId: string | null;
  occurredAt: string | null;
}

export interface KafkaView {
  recent(): FeedEvent[];
  onEvent(fn: (e: FeedEvent) => void): () => void;
  lag(): Promise<ConsumerLag[]>;
  close(): Promise<void>;
}

export async function kafkaView(brokers: string[], keep = 200): Promise<KafkaView> {
  const kafka = new Kafka({ clientId: 'ops-console', brokers, logLevel: logLevel.NOTHING });
  const admin = kafka.admin();
  await admin.connect();
  const consumer = kafka.consumer({ groupId: 'ops-console' });
  const buffer: FeedEvent[] = [];
  const listeners = new Set<(e: FeedEvent) => void>();

  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ partition, message }) => {
      const body = message.value ? (JSON.parse(message.value.toString()) as { eventType?: string; occurredAt?: string }) : {};
      const e: FeedEvent = {
        offset: message.offset,
        partition,
        eventType: body.eventType ?? 'unknown',
        doctorId: message.key?.toString() ?? null,
        occurredAt: body.occurredAt ?? null,
      };
      buffer.push(e);
      if (buffer.length > keep) buffer.shift();
      for (const fn of listeners) fn(e);
    },
  });

  return {
    recent: () => [...buffer],
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async lag() {
      const latest = await admin.fetchTopicOffsets(TOPIC);
      const latestBy = new Map(latest.map((p) => [p.partition, Number(p.high)]));
      return Promise.all(
        GROUPS.map(async (groupId) => {
          const [committed] = await admin.fetchOffsets({ groupId, topics: [TOPIC] });
          const partitions = committed.partitions.map((p) => {
            const top = latestBy.get(p.partition) ?? 0;
            const at = Number(p.offset) < 0 ? 0 : Number(p.offset); // -1 = nothing committed yet
            return { partition: p.partition, committed: at, latest: top, lag: Math.max(0, top - at) };
          });
          return { groupId, partitions, totalLag: partitions.reduce((n, p) => n + p.lag, 0) };
        }),
      );
    },
    async close() {
      await consumer.disconnect().catch(() => {});
      await admin.disconnect().catch(() => {});
    },
  };
}
