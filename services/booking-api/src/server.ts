import { buildApp } from './app.js';
import { config } from './config.js';
import { createPool } from './db.js';
import { createHealthChecker } from './health.js';
import { startHoldSweeper } from './jobs/hold-sweeper.js';
import { LiveHub } from './live/hub.js';
import { gracefulShutdown } from './shutdown.js';

const pool = createPool(config.databaseUrl);
const health = createHealthChecker({ pool, ...config });
const hub = new LiveHub(config.redisUrl);
const app = await buildApp({ pool, health, hub, webOrigin: config.webOrigin });
const stopSweeper = startHoldSweeper(pool, 10_000, (msg) => app.log.info(msg));

// Drain HTTP first, then close what the requests were using (see shutdown.ts).
const shutdown = gracefulShutdown(app, {
  log: (msg) => app.log.info(`[port ${config.port}] ${msg}`),
  cleanup: async () => {
    stopSweeper();
    await health.close();
    await hub.close();
    await pool.end();
  },
});
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: '0.0.0.0' });
