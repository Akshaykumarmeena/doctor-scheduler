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

/** A slot as shown to a patient: UTC instants plus the doctor's local wall-clock time. */
export interface SlotView extends Slot {
  localTime: string; // "09:15" in the doctor's tz
}

export interface Hold {
  holdId: string;
  slotId: string;
  doctorId: string;
  patientId: string;
  expiresAt: string;
  /** The held time: 15 or 30 minutes from the chosen slot. */
  start: string;
  end: string;
}

export type VisitType = 'in_person' | 'video';
export type AppointmentStatus = 'confirmed' | 'cancelled' | 'completed' | 'no_show';

export interface Appointment {
  id: string;
  slotId: string;
  doctorId: string;
  patientId: string;
  visitType: VisitType;
  status: AppointmentStatus;
  start: string;
  end: string;
  createdAt: string;
}

/** An appointment with the doctor details a patient needs to recognise it ("My appointments"). */
export interface PatientAppointment extends Appointment {
  doctorName: string;
  specialty: string;
  clinic: string;
  area: string;
  tz: string;
}

export interface Patient {
  id: string;
  name: string;
  phone: string;
}

/** Body of every 4xx/5xx response from booking-api. */
export interface ApiError {
  error: string;
  message: string;
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

export type SearchSort = 'relevance' | 'distance' | 'rating' | 'soonest';

export interface SearchParams {
  q?: string;
  specialty?: string;
  area?: string;
  language?: string;
  /** Local date YYYY-MM-DD: only doctors with a free slot that day. */
  date?: string;
  /** "Near me": a point and a radius. */
  lat?: number;
  lng?: number;
  radiusKm?: number;
  sort?: SearchSort;
  page?: number;
  pageSize?: number;
}

export interface SearchResult {
  doctor: Doctor;
  nextAvailable: string | null;
  availableDates: string[];
  openSlots: number;
  distanceKm: number | null;
  score: number | null;
}

export interface SearchResponse {
  total: number;
  tookMs: number;
  results: SearchResult[];
}

export interface SearchFacets {
  specialties: string[];
  languages: string[];
  areas: { name: string; lat: number; lng: number }[];
}
