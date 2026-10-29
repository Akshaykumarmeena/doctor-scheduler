// Live checks of the guarantees the whole system exists for. All but the backlog must always be 0.
// (The first two are also enforced by EXCLUDE constraints, so they can't even be planted in a test: they are
// canaries. If one ever reads non-zero, a constraint was dropped.)
import type pg from 'pg';
import type { Invariants } from '@ds/shared';

export async function checkInvariants(pool: pg.Pool): Promise<Invariants> {
  const { rows } = await pool.query<Omit<Invariants, 'checkedAt'>>(
    `WITH live AS (
       SELECT id, doctor_id, during FROM slots
        WHERE status = 'booked' OR (status = 'held' AND hold_expires_at >= now())
     )
     SELECT
       (SELECT count(*)::int FROM live a JOIN live b
          ON a.doctor_id = b.doctor_id AND a.id < b.id AND a.during && b.during) AS "doubleBookings",
       (SELECT count(*)::int FROM appointments a JOIN appointments b
          ON a.patient_id = b.patient_id AND a.id < b.id AND a.during && b.during
         WHERE a.status = 'confirmed' AND b.status = 'confirmed') AS "patientOverlaps",
       (SELECT count(*)::int FROM live s
         WHERE EXISTS (SELECT 1 FROM schedule_exceptions e WHERE e.doctor_id = s.doctor_id AND e.during && s.during)) AS "holdsInTimeOff",
       (SELECT count(*)::int FROM slots
         WHERE status = 'held' AND hold_expires_at < now() - interval '30 seconds') AS "expiredHoldsNotSwept",
       (SELECT count(*)::int FROM outbox WHERE published_at IS NULL) AS "outboxBacklog"`,
  );
  return { ...rows[0], checkedAt: new Date().toISOString() };
}
