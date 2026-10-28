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
