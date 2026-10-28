// Applies db/migrations/NNNN_*.sql in order. Each file runs in its own transaction and is
// recorded in schema_migrations, so re-running only applies new files.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
// Arbitrary constant; makes two concurrent runners queue instead of racing.
const LOCK_KEY = 727_001;

export async function runMigrations(databaseUrl: string, log: (msg: string) => void = console.log) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    log(`schema up to date (${files.length} files)`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL ?? 'postgres://scheduler:scheduler@localhost:5432/scheduler';
  runMigrations(url).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
