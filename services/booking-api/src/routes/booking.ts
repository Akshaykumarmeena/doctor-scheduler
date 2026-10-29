import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { VisitType } from '@ds/shared';
import type { Pool } from '../db.js';
import { notFound } from '../errors.js';
import { requestHash, requireKey, withIdempotency, type Tx } from '../idempotency.js';
import { VISIT_MINUTES, createHold, releaseHold, type VisitMinutes } from '../booking/holds.js';
import { confirmHold } from '../booking/confirm.js';
import { cancelAppointment } from '../booking/cancel.js';
import { appointmentsForPatient, getAppointment, getDoctor, listPatients, slotsForDay } from '../booking/queries.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

export function registerBookingRoutes(app: FastifyInstance, pool: Pool) {
  /** Every write goes through here: Idempotency-Key required, one transaction, stored response. */
  async function idempotent(
    req: FastifyRequest,
    reply: FastifyReply,
    successCode: number,
    handler: (tx: Tx, key: string) => Promise<unknown>,
  ) {
    const key = requireKey(req.headers['idempotency-key']);
    const result = await withIdempotency(pool, key, requestHash(req.method, req.url, req.body), async (tx) => ({
      statusCode: successCode,
      body: await handler(tx, key),
    }));
    return reply.code(result.statusCode).header('idempotent-replayed', String(result.replayed)).send(result.body);
  }

  // ── reads ──────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/doctors/:id', { schema: { params: idParams } }, async (req) => {
    const doctor = await getDoctor(pool, req.params.id);
    if (!doctor) throw notFound('doctor_not_found', 'No such doctor');
    return doctor;
  });

  app.get<{ Params: { id: string }; Querystring: { date: string } }>(
    '/doctors/:id/slots',
    {
      schema: {
        params: idParams,
        querystring: { type: 'object', required: ['date'], properties: { date: { type: 'string', format: 'date' } } },
      },
    },
    async (req) => ({ slots: await slotsForDay(pool, req.params.id, req.query.date) }),
  );

  app.get<{ Params: { id: string } }>('/appointments/:id', { schema: { params: idParams } }, async (req) => {
    const appointment = await getAppointment(pool, req.params.id);
    if (!appointment) throw notFound('appointment_not_found', 'No such appointment');
    return appointment;
  });

  app.get<{ Querystring: { limit?: number } }>(
    '/patients',
    { schema: { querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } } } },
    async (req) => ({ patients: await listPatients(pool, req.query.limit ?? 20) }),
  );

  app.get<{ Params: { id: string } }>('/patients/:id/appointments', { schema: { params: idParams } }, async (req) => ({
    appointments: await appointmentsForPatient(pool, req.params.id),
  }));

  // ── writes (idempotent) ────────────────────────────────────────────────────
  app.post<{ Body: { slotId: string; patientId: string; durationMinutes?: VisitMinutes } }>(
    '/holds',
    {
      schema: {
        body: {
          type: 'object',
          required: ['slotId', 'patientId'],
          additionalProperties: false,
          properties: { slotId: uuid, patientId: uuid, durationMinutes: { type: 'integer', enum: [...VISIT_MINUTES] } },
        },
      },
    },
    (req, reply) => idempotent(req, reply, 201, (tx) => createHold(tx, req.body)),
  );

  app.delete<{ Params: { id: string } }>('/holds/:id', { schema: { params: idParams } }, (req, reply) =>
    idempotent(req, reply, 200, (tx) => releaseHold(tx, req.params.id)),
  );

  app.post<{ Body: { holdId: string; visitType: VisitType } }>(
    '/appointments',
    {
      schema: {
        body: {
          type: 'object',
          required: ['holdId', 'visitType'],
          additionalProperties: false,
          properties: { holdId: uuid, visitType: { type: 'string', enum: ['in_person', 'video'] } },
        },
      },
    },
    (req, reply) => idempotent(req, reply, 201, (tx, key) => confirmHold(tx, { ...req.body, idempotencyKey: key })),
  );

  app.post<{ Params: { id: string } }>('/appointments/:id/cancel', { schema: { params: idParams } }, (req, reply) =>
    idempotent(req, reply, 200, (tx) => cancelAppointment(tx, req.params.id)),
  );
}
