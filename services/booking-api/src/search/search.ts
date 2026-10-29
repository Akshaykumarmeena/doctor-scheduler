// Executes doctor searches against OpenSearch and shapes the response. Search is a READ MODEL: it can lag
// Postgres by seconds, so it only suggests; booking always re-checks availability in Postgres.
import type { Doctor, SearchFacets, SearchParams, SearchResponse } from '@ds/shared';
import type { Pool } from '../db.js';
import { HttpError } from '../errors.js';
import { buildSearchQuery } from './query.js';

interface Hit {
  _score: number | null;
  _source: Doctor & {
    location: { lat: number; lon: number };
    next_available: string | null;
    available_dates: string[];
    open_slots: number;
  };
}

/** Great-circle distance in km (haversine). */
function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lon: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export async function searchDoctors(osUrl: string, index: string, params: SearchParams): Promise<SearchResponse> {
  let res: Response;
  try {
    res = await fetch(`${osUrl}/${index}/_search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildSearchQuery(params)),
      signal: AbortSignal.timeout(2000),
    });
  } catch (err) {
    throw new HttpError(503, 'search_unavailable', `Search is unavailable (${(err as Error).message}); booking still works`);
  }
  if (!res.ok) {
    throw new HttpError(503, 'search_unavailable', `Search is unavailable (OpenSearch HTTP ${res.status}); booking still works`);
  }
  const body = (await res.json()) as { took: number; hits: { total: { value: number }; hits: Hit[] } };
  const point = params.lat !== undefined && params.lng !== undefined ? { lat: params.lat, lng: params.lng } : null;

  return {
    total: body.hits.total.value,
    tookMs: body.took,
    results: body.hits.hits.map(({ _score, _source: s }) => ({
      doctor: {
        id: s.id, name: s.name, specialty: s.specialty, clinic: s.clinic, area: s.area,
        lat: s.location.lat, lng: s.location.lon, languages: s.languages, rating: s.rating, tz: s.tz,
      },
      nextAvailable: s.next_available,
      availableDates: s.available_dates,
      openSlots: s.open_slots,
      distanceKm: point ? Math.round(distanceKm(point, s.location) * 10) / 10 : null,
      score: _score,
    })),
  };
}

/** Filter options for the search page, straight from Postgres (areas carry their centre for "near"). */
export async function searchFacets(pool: Pool): Promise<SearchFacets> {
  const { rows } = await pool.query<SearchFacets>(
    `SELECT (SELECT array_agg(DISTINCT specialty ORDER BY specialty) FROM doctors) AS specialties,
            (SELECT array_agg(DISTINCT l ORDER BY l) FROM doctors, unnest(languages) l) AS languages,
            (SELECT json_agg(a ORDER BY a.name) FROM (
               SELECT area AS name, round(avg(lat)::numeric, 4)::float AS lat, round(avg(lng)::numeric, 4)::float AS lng
                 FROM doctors GROUP BY area) a) AS areas`,
  );
  return { specialties: rows[0].specialties ?? [], languages: rows[0].languages ?? [], areas: rows[0].areas ?? [] };
}
