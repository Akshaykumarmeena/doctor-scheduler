// The "doctors" search index: one document per doctor. Searches always go through the ALIAS, so a full
// rebuild can fill a new physical index (doctors_v<timestamp>) and swap the alias atomically.

export const DOCTORS_ALIAS = process.env.SEARCH_ALIAS ?? 'doctors';

export const DOCTORS_INDEX_BODY = {
  settings: {
    number_of_shards: 1, // 5,000 docs: one shard is plenty; shards are a unit of parallelism, not free
    number_of_replicas: 0, // single-node dev cluster; production would use >= 1
  },
  mappings: {
    dynamic: 'strict', // reject fields we did not declare instead of guessing their type
    properties: {
      id: { type: 'keyword' },
      // text = analysed (lower-cased, split into words) for full-text search; keyword = exact value for filters.
      name: { type: 'text' },
      specialty: { type: 'keyword', fields: { text: { type: 'text' } } },
      clinic: { type: 'text' },
      area: { type: 'keyword', fields: { text: { type: 'text' } } },
      languages: { type: 'keyword' },
      location: { type: 'geo_point' },
      rating: { type: 'float' },
      rating_count: { type: 'integer' }, // Phase 8: "★ 4.6 (128)"
      tz: { type: 'keyword', index: false },
      next_available: { type: 'date' },
      available_dates: { type: 'date', format: 'yyyy-MM-dd' }, // local dates with at least one free slot
      open_slots: { type: 'integer' },
      indexed_at: { type: 'date' },
    },
  },
} as const;

export interface DoctorDocument {
  id: string;
  name: string;
  specialty: string;
  clinic: string;
  area: string;
  languages: string[];
  location: { lat: number; lon: number };
  rating: number;
  rating_count: number;
  tz: string;
  next_available: string | null;
  available_dates: string[];
  open_slots: number;
  indexed_at: string;
}
