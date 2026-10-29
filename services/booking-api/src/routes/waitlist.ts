import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db.js';
import { sendIdempotent } from '../idempotency.js';
import { joinWaitlist, leaveWaitlist, waitlistForPatient } from '../waitlist.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

export function registerWaitlistRoutes(app: FastifyInstance, pool: Pool) {
  const idempotent = sendIdempotent(pool);

  app.post<{ Body: { doctorId: string; patientId: string; date: string } }>(
    '/waitlist',
    {
      schema: {
        body: {
          type: 'object',
          required: ['doctorId', 'patientId', 'date'],
          additionalProperties: false,
          properties: { doctorId: uuid, patientId: uuid, date: { type: 'string', format: 'date' } },
        },
      },
    },
    (req, reply) => idempotent(req, reply, 201, (tx) => joinWaitlist(tx, req.body)),
  );

  app.delete<{ Params: { id: string } }>('/waitlist/:id', { schema: { params: idParams } }, (req, reply) =>
    idempotent(req, reply, 200, (tx) => leaveWaitlist(tx, req.params.id)),
  );

  app.get<{ Params: { id: string } }>('/patients/:id/waitlist', { schema: { params: idParams } }, async (req) => ({
    entries: await waitlistForPatient(pool, req.params.id),
  }));
}
