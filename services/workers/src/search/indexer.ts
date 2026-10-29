// Search indexer: keeps the OpenSearch read model in step with Postgres.
//
// The Kafka event is only a NOTIFICATION ("doctor X changed"); the document is rebuilt from Postgres.
// So handling an event twice, or out of order, produces the same document: the indexer is idempotent
// and order-insensitive, which is exactly what at-least-once delivery requires.
import type pg from 'pg';
import { buildDoctorDocuments } from './documents.js';
import { DOCTORS_INDEX_BODY } from './mapping.js';
import { os, osOk } from './opensearch.js';

interface BulkResponse {
  errors: boolean;
  items: { index: { _id: string; status: number; error?: unknown } }[];
}

/** Rebuilds and upserts the documents for these doctors (all doctors if null). Returns how many. */
export async function indexDoctors(pool: pg.Pool, osUrl: string, index: string, doctorIds: string[] | null): Promise<number> {
  const docs = await buildDoctorDocuments(pool, doctorIds);
  for (let i = 0; i < docs.length; i += 1000) {
    const chunk = docs.slice(i, i + 1000);
    const lines = chunk.flatMap((d) => [{ index: { _index: index, _id: d.id } }, d]);
    const res = await osOk<BulkResponse>(osUrl, 'POST', '/_bulk', lines);
    if (res.errors) {
      const failed = res.items.find((it) => it.index.error);
      throw new Error(`bulk index had errors, e.g. ${JSON.stringify(failed?.index.error)}`);
    }
  }
  return docs.length;
}

export interface EventMessage {
  key: string | null;
  value: string | null;
}

/** Handles one Kafka batch: every distinct doctor mentioned gets its document rebuilt once. */
export async function handleEvents(pool: pg.Pool, osUrl: string, index: string, messages: EventMessage[]): Promise<number> {
  const doctorIds = new Set<string>();
  for (const m of messages) {
    const doctorId = m.key ?? (m.value ? (JSON.parse(m.value) as { doctorId?: string }).doctorId : undefined);
    if (doctorId) doctorIds.add(doctorId);
  }
  if (doctorIds.size === 0) return 0;
  return indexDoctors(pool, osUrl, index, [...doctorIds]);
}

/**
 * Full rebuild with zero downtime ("blue/green" index): fill a brand-new physical index, then move the alias
 * to it in ONE atomic _aliases call and delete the old index. Searches never see a half-built index.
 * (Events that arrive during the rebuild are written to the old index through the alias; the indexer's next
 * event for that doctor fixes the new one. Production systems close this gap by replaying from an offset.)
 */
export async function reindexAll(pool: pg.Pool, osUrl: string, alias: string) {
  const index = `${alias}_v${Date.now()}`;
  await osOk(osUrl, 'PUT', `/${index}`, DOCTORS_INDEX_BODY);
  const count = await indexDoctors(pool, osUrl, index, null);
  await osOk(osUrl, 'POST', `/${index}/_refresh`);

  const existing = await os<Record<string, unknown>>(osUrl, 'GET', `/_alias/${alias}`);
  const oldIndices = existing.status === 200 ? Object.keys(existing.body) : [];
  await osOk(osUrl, 'POST', '/_aliases', {
    actions: [...oldIndices.map((i) => ({ remove: { index: i, alias } })), { add: { index, alias } }],
  });
  for (const old of oldIndices) await osOk(osUrl, 'DELETE', `/${old}`);
  return { index, count, replaced: oldIndices };
}

export async function aliasExists(osUrl: string, alias: string) {
  return (await os(osUrl, 'HEAD', `/_alias/${alias}`)).status === 200;
}
