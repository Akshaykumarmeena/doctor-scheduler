// Doctor-side endpoints (Phase 5): week view, working hours, time off, utilization, visit outcomes.
import type { FastifyInstance } from 'fastify';
import type { TimeOffKind, WorkingHours } from '@ds/shared';
import type { Pool } from '../db.js';
import { sendIdempotent } from '../idempotency.js';
import { weekView } from '../doctor/week.js';
import { getWorkingHours, replaceWorkingHours } from '../doctor/hours.js';
import { addTimeOff, listTimeOff, previewTimeOff, removeTimeOff } from '../doctor/time-off.js';
import { doctorStats } from '../doctor/stats.js';
import { recordOutcome } from '../doctor/outcomes.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;
const localDateTime = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

export function registerDoctorAppRoutes(app: FastifyInstance, pool: Pool) {
  const idempotent = sendIdempotent(pool);

  app.get<{ Params: { id: string }; Querystring: { start: string } }>(
    '/doctors/:id/week',
    { schema: { params: idParams, querystring: { type: 'object', required: ['start'], properties: { start: date } } } },
    async (req) => weekView(pool, req.params.id, req.query.start),
  );

  // ── working hours ─────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/doctors/:id/templates', { schema: { params: idParams } }, async (req) => ({
    templates: await getWorkingHours(pool, req.params.id),
  }));

  app.put<{ Params: { id: string }; Body: { templates: WorkingHours[] } }>(
    '/doctors/:id/templates',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['templates'],
          additionalProperties: false,
          properties: {
            templates: {
              type: 'array',
              maxItems: 21,
              items: {
                type: 'object',
                required: ['weekday', 'startLocal', 'endLocal'],
                additionalProperties: false,
                properties: {
                  weekday: { type: 'integer', minimum: 1, maximum: 7 },
                  startLocal: { type: 'string' },
                  endLocal: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    (req, reply) => idempotent(req, reply, 200, (tx) => replaceWorkingHours(tx, req.params.id, req.body.templates)),
  );

  // ── time off ──────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/doctors/:id/time-off', { schema: { params: idParams } }, async (req) => ({
    timeOff: await listTimeOff(pool, req.params.id),
  }));

  app.get<{ Params: { id: string }; Querystring: { start: string; end: string } }>(
    '/doctors/:id/time-off/preview',
    {
      schema: {
        params: idParams,
        querystring: { type: 'object', required: ['start', 'end'], properties: { start: localDateTime, end: localDateTime } },
      },
    },
    async (req) => ({ affectedAppointments: await previewTimeOff(pool, req.params.id, req.query.start, req.query.end) }),
  );

  app.post<{ Params: { id: string }; Body: { start: string; end: string; kind: TimeOffKind; reason?: string } }>(
    '/doctors/:id/time-off',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['start', 'end', 'kind'],
          additionalProperties: false,
          properties: {
            start: localDateTime,
            end: localDateTime,
            kind: { type: 'string', enum: ['leave', 'holiday', 'blocked'] },
            reason: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    (req, reply) => idempotent(req, reply, 201, (tx) => addTimeOff(tx, { doctorId: req.params.id, ...req.body })),
  );

  app.delete<{ Params: { id: string; timeOffId: string } }>(
    '/doctors/:id/time-off/:timeOffId',
    {
      schema: {
        params: { type: 'object', required: ['id', 'timeOffId'], properties: { id: uuid, timeOffId: { type: 'string', pattern: '^[0-9]{1,18}$' } } },
      },
    },
    (req, reply) => idempotent(req, reply, 200, (tx) => removeTimeOff(tx, req.params.id, req.params.timeOffId)),
  );

  // ── utilization ───────────────────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { from: string; to: string } }>(
    '/doctors/:id/stats',
    { schema: { params: idParams, querystring: { type: 'object', required: ['from', 'to'], properties: { from: date, to: date } } } },
    async (req) => doctorStats(pool, req.params.id, req.query.from, req.query.to),
  );

  // ── visit outcomes (decision 3) ───────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/appointments/:id/complete', { schema: { params: idParams } }, (req, reply) =>
    idempotent(req, reply, 200, (tx) => recordOutcome(tx, req.params.id, 'completed')),
  );
  app.post<{ Params: { id: string } }>('/appointments/:id/no-show', { schema: { params: idParams } }, (req, reply) =>
    idempotent(req, reply, 200, (tx) => recordOutcome(tx, req.params.id, 'no_show')),
  );
}
