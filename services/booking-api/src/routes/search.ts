import type { FastifyInstance } from 'fastify';
import type { SearchParams } from '@ds/shared';
import type { Pool } from '../db.js';
import { searchDoctors, searchFacets } from '../search/search.js';

export interface SearchDeps {
  pool: Pool;
  opensearchUrl: string;
  searchIndex: string;
}

export function registerSearchRoutes(app: FastifyInstance, deps: SearchDeps) {
  app.get<{ Querystring: SearchParams }>(
    '/search',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: { type: 'string', maxLength: 200 },
            specialty: { type: 'string', maxLength: 100 },
            area: { type: 'string', maxLength: 100 },
            language: { type: 'string', maxLength: 50 },
            date: { type: 'string', format: 'date' },
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lng: { type: 'number', minimum: -180, maximum: 180 },
            radiusKm: { type: 'number', exclusiveMinimum: 0, maximum: 50 },
            sort: { type: 'string', enum: ['relevance', 'distance', 'rating', 'soonest'] },
            page: { type: 'integer', minimum: 1, maximum: 50 },
            pageSize: { type: 'integer', minimum: 1, maximum: 50 },
          },
          dependencies: { lat: ['lng'], lng: ['lat'] },
        },
      },
    },
    async (req) => searchDoctors(deps.opensearchUrl, deps.searchIndex, req.query),
  );

  app.get('/search/facets', async () => searchFacets(deps.pool));
}
