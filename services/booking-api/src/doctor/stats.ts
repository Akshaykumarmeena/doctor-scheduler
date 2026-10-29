// Utilization numbers for a doctor over a range of local dates (inclusive). Definitions, so nobody has to guess:
//   offered minutes   = base slots that are not blocked (held, booked or open all count as offered)
//   booked minutes    = minutes of appointments that happened or will happen: confirmed, completed, no_show
//                       (a 30-minute visit counts 30)
//   utilization       = booked / offered
//   cancellation rate = cancelled / (cancelled + not cancelled) appointments in the range
//   no-show rate      = no_show / (completed + no_show), i.e. only appointments that have an outcome
//   lead time         = average time from booking (created_at) to the visit, for non-cancelled appointments
//   waitlist waiting  = waiting entries whose wanted day falls in the range
import type { DoctorStats } from '@ds/shared';
import type { Pool } from '../db.js';
import { notFound, unprocessable } from '../errors.js';

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((1000 * part) / whole) / 10 : 0);

export async function doctorStats(pool: Pool, doctorId: string, from: string, to: string): Promise<DoctorStats> {
  if (to < from) throw unprocessable('bad_range', '"to" is before "from"');
  const { rows } = await pool.query<{
    date: string;
    offered: number;
    booked: number;
  }>(
    `WITH d AS (SELECT tz FROM doctors WHERE id = $1),
     days AS (SELECT gs::date AS date FROM generate_series($2::date, $3::date, interval '1 day') gs),
     offered AS (
       SELECT (lower(s.during) AT TIME ZONE d.tz)::date AS date,
              sum(extract(epoch FROM upper(s.during) - lower(s.during)) / 60)::int AS minutes
         FROM slots s, d
        WHERE s.doctor_id = $1 AND s.kind = 'base' AND s.status <> 'blocked'
          AND s.during && tstzrange($2::date::timestamp AT TIME ZONE d.tz, ($3::date + 1)::timestamp AT TIME ZONE d.tz)
        GROUP BY 1),
     booked AS (
       SELECT (lower(a.during) AT TIME ZONE d.tz)::date AS date,
              sum(extract(epoch FROM upper(a.during) - lower(a.during)) / 60)::int AS minutes
         FROM appointments a, d
        WHERE a.doctor_id = $1 AND a.status IN ('confirmed', 'completed', 'no_show')
          AND a.during && tstzrange($2::date::timestamp AT TIME ZONE d.tz, ($3::date + 1)::timestamp AT TIME ZONE d.tz)
        GROUP BY 1)
     SELECT to_char(days.date, 'YYYY-MM-DD') AS date, coalesce(o.minutes, 0) AS offered, coalesce(b.minutes, 0) AS booked
       FROM days LEFT JOIN offered o USING (date) LEFT JOIN booked b USING (date)
      ORDER BY days.date`,
    [doctorId, from, to],
  );
  const doctor = await pool.query('SELECT 1 FROM doctors WHERE id = $1', [doctorId]);
  if (doctor.rowCount === 0) throw notFound('doctor_not_found', 'No such doctor');

  const totals = await pool.query<{
    live: number;
    cancelled: number;
    completed: number;
    no_shows: number;
    lead_hours: number | null;
    waiting: number;
  }>(
    `WITH d AS (SELECT tz FROM doctors WHERE id = $1),
     r AS (SELECT tstzrange($2::date::timestamp AT TIME ZONE d.tz, ($3::date + 1)::timestamp AT TIME ZONE d.tz) AS range FROM d)
     SELECT count(*) FILTER (WHERE a.status <> 'cancelled')::int AS live,
            count(*) FILTER (WHERE a.status = 'cancelled')::int AS cancelled,
            count(*) FILTER (WHERE a.status = 'completed')::int AS completed,
            count(*) FILTER (WHERE a.status = 'no_show')::int AS no_shows,
            round((avg(extract(epoch FROM lower(a.during) - a.created_at) / 3600)
                    FILTER (WHERE a.status <> 'cancelled'))::numeric, 1)::float AS lead_hours,
            (SELECT count(*)::int FROM waitlist_entries w, r
              WHERE w.doctor_id = $1 AND w.status = 'waiting' AND w.desired_window && r.range) AS waiting
       FROM r LEFT JOIN appointments a ON a.doctor_id = $1 AND a.during && r.range`,
    [doctorId, from, to],
  );
  const t = totals.rows[0];
  const offeredMinutes = rows.reduce((n, r) => n + r.offered, 0);
  const bookedMinutes = rows.reduce((n, r) => n + r.booked, 0);
  return {
    from,
    to,
    offeredMinutes,
    bookedMinutes,
    utilizationPct: pct(bookedMinutes, offeredMinutes),
    appointments: t.live,
    cancellations: t.cancelled,
    cancellationRatePct: pct(t.cancelled, t.live + t.cancelled),
    noShows: t.no_shows,
    noShowRatePct: pct(t.no_shows, t.completed + t.no_shows),
    avgLeadTimeHours: t.lead_hours,
    waitlistWaiting: t.waiting,
    byDay: rows.map((r) => ({ date: r.date, offeredMinutes: r.offered, bookedMinutes: r.booked })),
  };
}
