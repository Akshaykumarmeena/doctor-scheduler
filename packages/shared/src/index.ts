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
  /** When the hold lapses unless renewed (the lease; heartbeats move it forward). */
  expiresAt: string;
  /** The hard cap: heartbeats can never extend the hold past this. */
  deadlineAt: string;
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

// ── Phase 4: events ─────────────────────────────────────────────────────────

export type NotificationKind = 'booked' | 'cancelled' | 'offer' | 'offer_expired' | 'reminder_24h' | 'reminder_1h';

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  appointmentId: string | null;
  holdId: string | null;
  createdAt: string;
  readAt: string | null;
}

export type WaitlistStatus = 'waiting' | 'offered' | 'booked' | 'expired' | 'cancelled';

export interface WaitlistOffer {
  holdId: string;
  slotId: string;
  start: string;
  end: string;
  expiresAt: string;
}

export interface WaitlistEntry {
  id: string;
  doctorId: string;
  patientId: string;
  /** The doctor-local day the patient wants any slot on. */
  date: string;
  status: WaitlistStatus;
  offer: WaitlistOffer | null;
  createdAt: string;
}

/** What the live-fanout worker publishes to Redis channel doctor:<id> and the SSE stream forwards. */
export interface LiveSlotEvent {
  doctorId: string;
  eventType: string;
  start: string | null;
  end: string | null;
  at: string;
}

// ── Phase 5: doctor app ─────────────────────────────────────────────────────

export interface WeekSlotAppointment {
  id: string;
  patientName: string;
  visitType: VisitType;
  minutes: number;
  status: AppointmentStatus;
  /** false on the second 15-minute row of a 30-minute visit (draw it as one block). */
  startsHere: boolean;
}

export interface WeekSlot {
  id: string;
  start: string;
  end: string;
  localTime: string;
  status: SlotStatus;
  blockedReason: 'hours' | 'time_off' | null;
  appointment: WeekSlotAppointment | null;
  /** A booking kept after the doctor removed these hours (decision 1a): show it, flagged. */
  outsideHours: boolean;
}

export interface WeekView {
  doctorId: string;
  tz: string;
  days: { date: string; slots: WeekSlot[] }[];
}

export interface WorkingHours {
  /** Set on rules read back from the server; omit when sending a new set. */
  id?: string;
  weekday: number; // ISO: 1 = Monday
  startLocal: string; // "09:00"
  endLocal: string; // "13:00"
}

export type TimeOffKind = 'leave' | 'holiday' | 'blocked';

export interface TimeOff {
  id: string;
  start: string;
  end: string;
  kind: TimeOffKind;
  reason: string | null;
}

export interface AffectedAppointment {
  id: string;
  patientName: string;
  start: string;
  end: string;
}

export interface DoctorStats {
  from: string;
  to: string;
  offeredMinutes: number;
  bookedMinutes: number;
  utilizationPct: number;
  appointments: number;
  cancellations: number;
  cancellationRatePct: number;
  noShows: number;
  noShowRatePct: number;
  avgLeadTimeHours: number | null;
  waitlistWaiting: number;
  byDay: { date: string; offeredMinutes: number; bookedMinutes: number }[];
}

// ── Phase 6: engineering console (dev-only ops service) ────────────────────

export interface OpsService {
  name: string;
  kind: 'container' | 'process';
  status: 'up' | 'down';
  healthy: boolean;
  /** false for postgres: the source of truth can't be stopped from the console. */
  controllable: boolean;
}

export interface RaceResult {
  mode: 'api' | 'naive';
  racers: number;
  slot: string;
  /** api mode */
  held: number;
  rejected: number;
  other: number;
  /** naive mode: how many racers were told "you got it", and how often the row was overwritten */
  naiveToldYes: number;
  overwrites: number;
  ms: number;
}

export interface ConsumerLag {
  groupId: string;
  partitions: { partition: number; committed: number; latest: number; lag: number }[];
  totalLag: number;
}

export interface Invariants {
  doubleBookings: number;
  patientOverlaps: number;
  holdsInTimeOff: number;
  expiredHoldsNotSwept: number;
  /** not an error by itself: events waiting for the relay */
  outboxBacklog: number;
  checkedAt: string;
}

export interface LoadRun {
  runId: string;
  status: 'running' | 'done' | 'failed';
  vus: number;
  durationSec: number;
  rollingRestart: boolean;
  startedAt: string;
  rps: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  errorRate: number | null;
  checksPassed: number | null;
  restartTimeline: { atSec: number; event: string }[];
  invariantsAfter: Invariants | null;
  error?: string;
}
