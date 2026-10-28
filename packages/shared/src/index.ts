// Types shared by booking-api, workers and web.

export type SlotStatus = 'open' | 'held' | 'booked' | 'blocked';

export interface Doctor {
  id: string;
  name: string;
  specialty: string;
  clinic: string;
  area: string;
  lat: number;
  lng: number;
  languages: string[];
  rating: number;
  tz: string;
}

export interface Slot {
  id: string;
  doctorId: string;
  /** ISO-8601 UTC instants; the interval is [start, end). */
  start: string;
  end: string;
  status: SlotStatus;
  version: number;
}

export type DependencyName = 'postgres' | 'redis' | 'redpanda' | 'opensearch';

export interface DependencyHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface HealthReport {
  ok: boolean;
  checkedAt: string;
  dependencies: Record<DependencyName, DependencyHealth>;
}
