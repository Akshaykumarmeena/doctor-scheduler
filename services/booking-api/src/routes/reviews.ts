import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db.js';
import { sendIdempotent } from '../idempotency.js';
import { createReview, reviewsForDoctor } from '../reviews.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

export function registerReviewRoutes(app: FastifyInstance, pool: Pool) {
  const idempotent = sendIdempotent(pool);

  app.post<{ Params: { id: string }; Body: { patientId: string; stars: number; comment?: string } }>(
    '/appointments/:id/review',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['patientId', 'stars'],
          additionalProperties: false,
          properties: {
            patientId: uuid,
            stars: { type: 'integer', minimum: 1, maximum: 5 },
            comment: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    (req, reply) => idempotent(req, reply, 201, (tx) => createReview(tx, req.params.id, req.body)),
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: number } }>(
    '/doctors/:id/reviews',
    {
      schema: {
        params: idParams,
        querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 5 } } },
      },
    },
    async (req) => reviewsForDoctor(pool, req.params.id, req.query.limit ?? 5),
  );
}
