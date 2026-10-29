import type { FastifyInstance } from 'fastify';
import type { VisitType } from '@ds/shared';
import type { Pool } from '../db.js';
import { notFound } from '../errors.js';
import { sendIdempotent } from '../idempotency.js';
import {
  HOLD_LEASE_RANGE,
  HOLD_TTL_RANGE,
  VISIT_MINUTES,
  createHold,
  heartbeatHold,
  liveHoldsForPatient,
  releaseHold,
  type VisitMinutes,
} from '../booking/holds.js';
import { conflict } from '../errors.js';
import { confirmHold } from '../booking/confirm.js';
import { cancelAppointment } from '../booking/cancel.js';
import { appointmentsForPatient, getAppointment, getDoctor, listPatients, slotsForDay } from '../booking/queries.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

export function registerBookingRoutes(app: FastifyInstance, pool: Pool) {
  const idempotent = sendIdempotent(pool);

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
  app.post<{
    Body: { slotId: string; patientId: string; durationMinutes?: VisitMinutes; ttlSeconds?: number; leaseSeconds?: number };
  }>(
    '/holds',
    {
      schema: {
        body: {
          type: 'object',
          required: ['slotId', 'patientId'],
          additionalProperties: false,
          properties: {
            slotId: uuid,
            patientId: uuid,
            durationMinutes: { type: 'integer', enum: [...VISIT_MINUTES] },
            ttlSeconds: { type: 'integer', minimum: HOLD_TTL_RANGE.min, maximum: HOLD_TTL_RANGE.max },
            leaseSeconds: { type: 'integer', minimum: HOLD_LEASE_RANGE.min, maximum: HOLD_LEASE_RANGE.max },
          },
        },
      },
    },
    (req, reply) => idempotent(req, reply, 201, (tx) => createHold(tx, req.body)),
  );

  app.post<{ Params: { id: string }; Body: { leaseSeconds?: number } | undefined }>(
    '/holds/:id/heartbeat',
    {
      schema: {
        params: idParams,
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: { leaseSeconds: { type: 'integer', minimum: HOLD_LEASE_RANGE.min, maximum: HOLD_LEASE_RANGE.max } },
        },
      },
    },
    (req, reply) => idempotent(req, reply, 200, (tx) => heartbeatHold(tx, req.params.id, req.body?.leaseSeconds ?? 120)),
  );

  app.get<{ Params: { id: string } }>('/patients/:id/holds', { schema: { params: idParams } }, async (req) => ({
    holds: await liveHoldsForPatient(pool, req.params.id),
  }));

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
    (req, reply) =>
      idempotent(req, reply, 201, (tx, key) =>
        confirmHold(tx, { ...req.body, idempotencyKey: key }).catch((err: { code?: string; constraint?: string }) => {
          // The patient already has a confirmed appointment overlapping this one (any doctor).
          if (err.code === '23P01' && err.constraint === 'appointments_patient_no_overlap') {
            throw conflict('patient_busy', 'You already have an appointment at this time');
          }
          throw err;
        }),
      ),
  );

  app.post<{ Params: { id: string } }>('/appointments/:id/cancel', { schema: { params: idParams } }, (req, reply) =>
    idempotent(req, reply, 200, (tx) => cancelAppointment(tx, req.params.id)),
  );
}
