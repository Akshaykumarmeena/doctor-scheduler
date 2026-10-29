import { describe, expect, it } from 'vitest';
import { buildSearchQuery } from '../src/search/query.js';

const bool = (q: ReturnType<typeof buildSearchQuery>) => q.query.function_score.query.bool;

describe('buildSearchQuery', () => {
  it('puts exact constraints in filter (unscored) and free text in must (scored)', () => {
    const q = buildSearchQuery({ q: 'heart', specialty: 'Cardiology', language: 'Kannada', date: '2026-11-02', area: 'Koramangala' });
    expect(bool(q).filter).toEqual([
      { term: { specialty: 'Cardiology' } },
      { term: { languages: 'Kannada' } },
      { term: { available_dates: '2026-11-02' } },
      { term: { area: 'Koramangala' } },
    ]);
    expect(bool(q).must[0]).toMatchObject({
      bool: {
        should: [{ multi_match: { query: 'heart', type: 'bool_prefix' } }, { multi_match: { query: 'heart', fuzziness: 'AUTO' } }],
        minimum_should_match: 1,
      },
    });
  });

  it('matches everything when there is no text', () => {
    expect(bool(buildSearchQuery({})).must).toEqual([{ match_all: {} }]);
  });

  it('"near" uses a geo_distance filter and replaces the area filter', () => {
    const q = buildSearchQuery({ area: 'Koramangala', lat: 12.93, lng: 77.62, radiusKm: 3 });
    expect(bool(q).filter).toEqual([{ geo_distance: { distance: '3km', location: { lat: 12.93, lon: 77.62 } } }]);
  });

  it('sorts by distance only when there is a point to measure from', () => {
    expect(buildSearchQuery({ sort: 'distance' }).sort).toEqual(['_score', { rating: 'desc' }]);
    expect(buildSearchQuery({ sort: 'distance', lat: 1, lng: 2 }).sort).toEqual([
      { _geo_distance: { location: { lat: 1, lon: 2 }, order: 'asc', unit: 'km' } },
    ]);
  });

  it('ranks by relevance x log(2 + rating), never zero for an unrated doctor, and pages', () => {
    const q = buildSearchQuery({ page: 3, pageSize: 10 });
    expect(q.query.function_score.functions[0]).toEqual({ field_value_factor: { field: 'rating', modifier: 'log2p', missing: 0 } });
    expect([q.from, q.size]).toEqual([20, 10]);
  });
});
