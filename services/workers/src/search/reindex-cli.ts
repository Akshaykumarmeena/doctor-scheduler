// npm run search:reindex  ->  rebuild the doctors index from Postgres and swap the alias.
import pg from 'pg';
import { reindexAll } from './indexer.js';
import { DOCTORS_ALIAS } from './mapping.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://scheduler:scheduler@localhost:5432/scheduler' });
const osUrl = process.env.OPENSEARCH_URL ?? 'http://localhost:9200';
const started = performance.now();
try {
  const r = await reindexAll(pool, osUrl, DOCTORS_ALIAS);
  console.log(
    `indexed ${r.count} doctors into ${r.index}; alias "${DOCTORS_ALIAS}" now points to it` +
      `${r.replaced.length ? ` (replaced ${r.replaced.join(', ')})` : ''} (${Math.round(performance.now() - started)} ms)`,
  );
} finally {
  await pool.end();
}
