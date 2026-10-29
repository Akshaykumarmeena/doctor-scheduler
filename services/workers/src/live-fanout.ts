// live-fanout: Kafka -> Redis pub/sub. Every booking event becomes a small "doctor X changed" message on
// channel doctor:<id>, which every booking-api instance forwards to its open SSE streams.
//
// Why not let each API instance consume Kafka itself? Then each instance would need its own consumer group
// (to see every message) and its own partitions bookkeeping. One small consumer + Redis pub/sub fans out to any
// number of instances, and Redis is already the place for ephemeral, non-durable messages.
import type { LiveSlotEvent } from '@ds/shared';
import { parseEvents, type RawMessage } from './events.js';
import type { Publish } from './notify.js';

export async function fanOut(publish: Publish, messages: RawMessage[]): Promise<number> {
  const events = parseEvents(messages);
  for (const e of events) {
    const live: LiveSlotEvent = {
      doctorId: e.doctorId,
      eventType: e.eventType,
      start: e.payload.start ?? null,
      end: e.payload.end ?? null,
      at: e.occurredAt,
    };
    await publish(`doctor:${e.doctorId}`, JSON.stringify(live));
  }
  return events.length;
}
