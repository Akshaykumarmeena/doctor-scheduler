// Dev-only ops service for the /console page. Refuses to start without OPS_ENABLED=1; binds to 127.0.0.1.
// With OPS_SUPERVISE=1 (npm run dev:cluster) it also starts and supervises api-1, api-2 and the workers.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { assertOpsEnabled, OPS_HOST } from './guard.js';
import { buildOpsApp } from './app.js';
import { composeDocker } from './docker.js';
import { processSupervisor, unmanagedProcesses } from './supervisor.js';
import { kafkaView } from './kafka.js';
import { loadRunner } from './load.js';

assertOpsEnabled(process.env);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const log = (line: string) => console.log(line);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://scheduler:scheduler@localhost:5432/scheduler', max: 60 });
const processes = process.env.OPS_SUPERVISE === '1' ? processSupervisor(repoRoot, log) : unmanagedProcesses;
const kafka = await kafkaView((process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',')).catch((e) => {
  log(`ops: Kafka feed unavailable (${(e as Error).message})`);
  return null;
});

if (processes.managed) {
  for (const name of ['api-1', 'api-2', 'workers'] as const) await processes.start(name);
  log('ops: supervising api-1 (:4001), api-2 (:4002) and workers; nginx on :4000 balances the two APIs');
}

const app = await buildOpsApp({
  pool,
  docker: composeDocker(repoRoot),
  processes,
  kafka,
  load: loadRunner({ repoRoot, processes, pool, log }),
  apiUrl: process.env.API_URL ?? 'http://localhost:4000',
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
});

const shutdown = async () => {
  await app.close();
  await processes.stopAll();
  await kafka?.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: Number(process.env.OPS_PORT ?? 4100), host: OPS_HOST });
log(`ops: console API on http://${OPS_HOST}:${process.env.OPS_PORT ?? 4100} (dev only)`);
