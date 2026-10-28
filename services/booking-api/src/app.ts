import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Pool } from './db.js';
import type { HealthChecker } from './health.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerDoctorRoutes } from './routes/doctors.js';

export interface AppDeps {
  pool: Pool;
  health: HealthChecker;
  webOrigin: string;
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(cors, { origin: deps.webOrigin });
  registerHealthRoutes(app, deps.health);
  registerDoctorRoutes(app, deps.pool);
  return app;
}
