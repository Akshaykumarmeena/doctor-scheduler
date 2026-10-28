import type { FastifyInstance } from 'fastify';
import type { HealthChecker } from '../health.js';

export function registerHealthRoutes(app: FastifyInstance, health: HealthChecker) {
  // 503 when any dependency is down, so a load balancer / compose healthcheck can act on it.
  app.get('/health', async (_req, reply) => {
    const report = await health.check();
    return reply.code(report.ok ? 200 : 503).send(report);
  });
}
