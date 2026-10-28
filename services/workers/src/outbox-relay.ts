// Outbox relay: Postgres `outbox` -> Redpanda topic "appointments".
//
// Each batch: lock up to N unpublished rows (SKIP LOCKED, so a second relay takes different rows),
// publish them keyed by doctor_id, then mark them published and COMMIT. If publishing fails we roll back
// and the rows are retried next tick. If we crash after publishing but before COMMIT, the rows are
// published again: delivery is AT-LEAST-ONCE, and consumers dedupe on eventId (= outbox.id).
import type pg from 'pg';

export const TOPIC = 'appointments';

export interface OutboxEvent {
  eventId: string;
  eventType: string;
  doctorId: string;
  aggregateId: string;
  occurredAt: string;
  payload: unknown;
}

/** The slice of a Kafka producer the relay needs; tests pass a fake. */
export interface EventPublisher {
  publish(topic: string, messages: { key: string; value: string; headers: Record<string, string> }[]): Promise<void>;
}

export async function relayOnce(pool: pg.Pool, publisher: EventPublisher, batchSize = 100): Promise<number> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const { rows } = await tx.query<OutboxEvent>(
      `SELECT id::text AS "eventId", event_type AS "eventType", doctor_id AS "doctorId",
              aggregate_id AS "aggregateId", created_at AS "occurredAt", payload
         FROM outbox
        WHERE published_at IS NULL
        ORDER BY id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    if (rows.length === 0) {
      await tx.query('COMMIT');
      return 0;
    }

    // Same doctor -> same key -> same partition -> consumers see that doctor's events in order.
    await publisher.publish(
      TOPIC,
      rows.map((e) => ({ key: e.doctorId, value: JSON.stringify(e), headers: { 'event-type': e.eventType } })),
    );
    await tx.query('UPDATE outbox SET published_at = now() WHERE id = ANY ($1::bigint[])', [rows.map((e) => e.eventId)]);
    await tx.query('COMMIT');
    return rows.length;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}
