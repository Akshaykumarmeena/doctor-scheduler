import { buildApp } from './app.js';
import { config } from './config.js';
import { createPool } from './db.js';
import { createHealthChecker } from './health.js';
import { startHoldSweeper } from './jobs/hold-sweeper.js';
import { LiveHub } from './live/hub.js';

const pool = createPool(config.databaseUrl);
const health = createHealthChecker({ pool, ...config });
const hub = new LiveHub(config.redisUrl);
const app = await buildApp({ pool, health, hub, webOrigin: config.webOrigin });
const stopSweeper = startHoldSweeper(pool, 10_000, (msg) => app.log.info(msg));

const shutdown = async () => {
  stopSweeper();
  await app.close();
  await health.close();
  await hub.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
