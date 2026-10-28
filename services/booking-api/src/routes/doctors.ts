import type { FastifyInstance } from 'fastify';
import type { Doctor } from '@ds/shared';
import type { Pool } from '../db.js';

export function registerDoctorRoutes(app: FastifyInstance, pool: Pool) {
  app.get<{ Querystring: { limit?: number } }>(
    '/doctors',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        },
      },
    },
    async (req) => {
      const { rows } = await pool.query<Doctor>(
        `SELECT id, name, specialty, clinic, area, lat, lng, languages, rating, tz
           FROM doctors
          ORDER BY name, id
          LIMIT $1`,
        [req.query.limit ?? 20],
      );
      return { doctors: rows };
    },
  );
}
