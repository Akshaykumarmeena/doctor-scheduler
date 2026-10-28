// npm run db:materialize [-- --days 14]
import { config } from './config.js';
import { createPool } from './db.js';
import { materializeSlots } from './materializer.js';

const daysArg = process.argv.indexOf('--days');
const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 14;

const pool = createPool(config.databaseUrl);
const started = performance.now();
try {
  const inserted = await materializeSlots(pool, { days });
  const { rows } = await pool.query<{ total: number }>('SELECT count(*)::int AS total FROM slots');
  console.log(
    `materialized ${days} days: ${inserted} new slots, ${rows[0].total} total ` +
      `(${Math.round(performance.now() - started)} ms)`,
  );
} finally {
  await pool.end();
}
