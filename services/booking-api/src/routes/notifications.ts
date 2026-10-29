import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db.js';
import { sendIdempotent } from '../idempotency.js';
import { listNotifications, markRead } from '../notifications.js';

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

export function registerNotificationRoutes(app: FastifyInstance, pool: Pool) {
  const idempotent = sendIdempotent(pool);

  app.get<{ Params: { id: string }; Querystring: { unread?: boolean } }>(
    '/patients/:id/notifications',
    { schema: { params: idParams, querystring: { type: 'object', properties: { unread: { type: 'boolean', default: false } } } } },
    async (req) => listNotifications(pool, req.params.id, req.query.unread ?? false),
  );

  app.post<{ Params: { id: string } }>('/notifications/:id/read', { schema: { params: idParams } }, (req, reply) =>
    idempotent(req, reply, 200, (tx) => markRead(tx, req.params.id)),
  );
}
