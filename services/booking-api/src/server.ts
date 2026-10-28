import { buildApp } from './app.js';
import { config } from './config.js';
import { createPool } from './db.js';
import { createHealthChecker } from './health.js';

const pool = createPool(config.databaseUrl);
const health = createHealthChecker({ pool, ...config });
const app = await buildApp({ pool, health, webOrigin: config.webOrigin });

const shutdown = async () => {
  await app.close();
  await health.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
