// Turns search filters into an OpenSearch query. Phase 3's critical piece. Akshay chose mode C: Claude
// writes it and walks through it, and Akshay answers review questions before it is committed.
import type { SearchParams } from '@ds/shared';

export const DEFAULT_RADIUS_KM = 5;
export const DEFAULT_PAGE_SIZE = 20;

type Clause = Record<string, unknown>;

export function buildSearchQuery(p: SearchParams) {
  const point = p.lat !== undefined && p.lng !== undefined ? { lat: p.lat, lon: p.lng } : null;

  // FILTER clauses: yes/no conditions. They do not affect the score, and OpenSearch caches them,
  // so they are cheap and fast. Every exact constraint goes here.
  const filter: Clause[] = [];
  if (p.specialty) filter.push({ term: { specialty: p.specialty } }); // keyword field: exact, case-sensitive
  if (p.language) filter.push({ term: { languages: p.language } }); // matches if ANY array element equals it
  if (p.date) filter.push({ term: { available_dates: p.date } }); // has a free slot on that local date
  if (point) {
    filter.push({ geo_distance: { distance: `${p.radiusKm ?? DEFAULT_RADIUS_KM}km`, location: point } });
  } else if (p.area) {
    filter.push({ term: { area: p.area } });
  }

  // MUST clause: free text. It is scored (BM25), so better matches rank higher. Name hits count 3x,
  // specialty 2x. Two ways to match, either is enough (bool.should, minimum_should_match 1):
  //   - bool_prefix: the LAST word is a prefix, so search-as-you-type works ("cardio" -> Cardiology)
  //   - fuzziness AUTO: whole words with 1-2 typos ("priyaa" -> Priya); bool_prefix can't fuzz its last word
  // No text -> match everything.
  const fields = ['name^3', 'specialty.text^2', 'clinic', 'area.text'];
  const must: Clause[] = p.q?.trim()
    ? [
        {
          bool: {
            should: [
              { multi_match: { query: p.q.trim(), type: 'bool_prefix', fields } },
              { multi_match: { query: p.q.trim(), fields, fuzziness: 'AUTO' } },
            ],
            minimum_should_match: 1,
          },
        },
      ]
    : [{ match_all: {} }];

  // Ranking: text relevance multiplied by log(1 + rating), so a 4.8 doctor edges out an equally relevant
  // 3.2 doctor, but rating never swamps relevance.
  const query = {
    function_score: {
      query: { bool: { must, filter } },
      functions: [{ field_value_factor: { field: 'rating', modifier: 'log1p', missing: 0 } }],
      boost_mode: 'multiply',
    },
  };

  const sortBy = p.sort === 'distance' && !point ? 'relevance' : (p.sort ?? 'relevance');
  const sort: Clause[] | string[] = {
    relevance: ['_score', { rating: 'desc' }],
    rating: [{ rating: 'desc' }, '_score'],
    soonest: [{ next_available: { order: 'asc', missing: '_last' } }, '_score'],
    distance: [{ _geo_distance: { location: point, order: 'asc', unit: 'km' } }],
  }[sortBy] as Clause[];

  const size = Math.min(p.pageSize ?? DEFAULT_PAGE_SIZE, 50);
  return {
    query,
    sort,
    size,
    from: ((p.page ?? 1) - 1) * size, // deep paging gets expensive; fine for page 1..10
    track_total_hits: true,
    track_scores: true, // keep _score even when sorting by something else
  };
}
