// npm run demo:reset: put the local demo back into a known state before an interview.
//
// It DELETES all appointments, notifications, waitlist entries, idempotency keys, outbox rows and demo time off
// (the seeded "Personal leave" days stay), releases every hold and reopens slots booked or closed for time off.
// Doctors, patients and working hours are kept. Then it books two known appointments through the API and rebuilds
// the search index. Like the seed, it writes `slots` directly: an admin script, a documented exception to
// invariant 1. Local development data only.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { materializeSlots } from '../services/booking-api/src/materializer.js';
import { reindexAll } from '../services/workers/src/search/indexer.js';

const DB = process.env.DATABASE_URL ?? 'postgres://scheduler:scheduler@localhost:5432/scheduler';
const API = process.env.API_URL ?? 'http://localhost:4000';
const OS = process.env.OPENSEARCH_URL ?? 'http://localhost:9200';
export const DEMO_DOCTOR = '00b6826f-d1a5-40f2-b3fa-4990bb2706b9'; // Dr. Shreya Kulkarni (docs/demo/DEMO-SCRIPT.md)

const pool = new pg.Pool({ connectionString: DB });

async function wipe() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Reopen booked/held/time-off slots and unlink appointments in one statement (a booked row must keep its
    // appointment_id, so they can't be separated).
    const reopenedSlots = (
      await client.query(
        `UPDATE slots SET status = 'open', appointment_id = NULL, hold_id = NULL, hold_patient_id = NULL,
                hold_expires_at = NULL, hold_deadline_at = NULL, blocked_reason = NULL, version = version + 1, updated_at = now()
          WHERE status IN ('held', 'booked') OR blocked_reason = 'time_off' OR appointment_id IS NOT NULL`,
      )
    ).rowCount;
    const counts = {
      reopenedSlots,
      notifications: (await client.query('DELETE FROM notifications')).rowCount, // before appointments (FK)
      appointments: (await client.query('DELETE FROM appointments')).rowCount,
      waitlist: (await client.query('DELETE FROM waitlist_entries')).rowCount,
      idempotencyKeys: (await client.query('DELETE FROM idempotency_keys')).rowCount,
      outbox: (await client.query('DELETE FROM outbox')).rowCount,
      composite30min: (await client.query(`DELETE FROM slots WHERE kind = 'composite'`)).rowCount,
      demoTimeOff: (await client.query(`DELETE FROM schedule_exceptions WHERE reason IS DISTINCT FROM 'Personal leave'`)).rowCount,
    };
    await client.query('COMMIT');
    return counts;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Two known bookings for the demo doctor, on the next weekday at least 2 days away. */
async function demoBookings() {
  const { rows } = await pool.query<{ day: string }>(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day
       FROM generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date + 2, (now() AT TIME ZONE 'Asia/Kolkata')::date + 9, interval '1 day') d
      WHERE extract(isodow FROM d) BETWEEN 1 AND 5 LIMIT 1`,
  );
  const day = rows[0].day;
  const patients = (await pool.query<{ id: string; name: string }>('SELECT id, name FROM patients ORDER BY name, id LIMIT 2')).rows;
  const slots = (await pool.query<{ id: string; t: string }>(
    `SELECT s.id, to_char(lower(s.during) AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS t
       FROM slots s WHERE s.doctor_id = $1 AND s.kind = 'base' AND s.status = 'open'
        AND (lower(s.during) AT TIME ZONE 'Asia/Kolkata')::date = $2::date`,
    [DEMO_DOCTOR, day],
  )).rows;
  const at = (t: string) => slots.find((s) => s.t === t)?.id;
  const made: string[] = [];
  for (const [i, [time, minutes]] of ([['10:00', 15], ['11:00', 30]] as const).entries()) {
    const slotId = at(time);
    if (!slotId) continue;
    const hold = await call<{ holdId: string }>('POST', '/holds', { slotId, patientId: patients[i].id, durationMinutes: minutes });
    await call('POST', '/appointments', { holdId: hold.holdId, visitType: 'in_person' });
    made.push(`${day} ${time} (${minutes} min) for ${patients[i].name}`);
  }
  return made;
}

try {
  console.log('demo:reset: wiping dynamic demo data…');
  console.log(await wipe());
  console.log(`demo:reset: re-materialized ${await materializeSlots(pool, { days: 14 })} slots`);
  console.log('demo:reset: demo bookings:', await demoBookings());
  const r = await reindexAll(pool, OS, 'doctors');
  console.log(`demo:reset: search rebuilt (${r.count} doctors). Ready.`);
} finally {
  await pool.end();
}
