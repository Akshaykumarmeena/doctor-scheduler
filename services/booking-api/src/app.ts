import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Pool } from './db.js';
import { HttpError } from './errors.js';
import type { HealthChecker } from './health.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerDoctorRoutes } from './routes/doctors.js';
import { registerBookingRoutes } from './routes/booking.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerWaitlistRoutes } from './routes/waitlist.js';
import { registerStreamRoutes } from './routes/stream.js';
import type { LiveHub } from './live/hub.js';
import { config } from './config.js';

export interface AppDeps {
  pool: Pool;
  health: HealthChecker;
  webOrigin: string;
  /** Where search reads from; defaults to config (OPENSEARCH_URL, alias "doctors"). */
  opensearchUrl?: string;
  searchIndex?: string;
  /** Redis subscriber for the SSE streams; without it the stream routes are not registered. */
  hub?: LiveHub;
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(cors, {
    origin: deps.webOrigin,
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['content-type', 'idempotency-key'],
    exposedHeaders: ['idempotent-replayed'],
  });

  // One error shape for every failure: { error, message }.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    const e = err as { validation?: unknown; message: string };
    if (e.validation) return reply.code(400).send({ error: 'invalid_request', message: e.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Internal server error' });
  });

  registerHealthRoutes(app, deps.health);
  registerDoctorRoutes(app, deps.pool);
  registerBookingRoutes(app, deps.pool);
  registerSearchRoutes(app, {
    pool: deps.pool,
    opensearchUrl: deps.opensearchUrl ?? config.opensearchUrl,
    searchIndex: deps.searchIndex ?? config.searchIndex,
  });
  registerNotificationRoutes(app, deps.pool);
  registerWaitlistRoutes(app, deps.pool);
  if (deps.hub) registerStreamRoutes(app, { pool: deps.pool, hub: deps.hub, webOrigin: deps.webOrigin });
  return app;
}
