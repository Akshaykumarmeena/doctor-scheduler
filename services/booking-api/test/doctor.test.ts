// Phase 5: the doctor app. Week view, working-hours changes (decision 1a: keep + flag bookings), time off
// (decision 2a: cancel + notify), visit outcomes, utilization numbers, and the time-off vs hold race.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Appointment, DoctorStats, Hold, WeekView } from '@ds/shared';
import { buildApp } from '../src/app.js';
import { materializeSlots } from '../src/materializer.js';
import { handleNotifierEvents } from '../../workers/src/notifier.js';
import { testDatabaseUrl } from '../../../test/test-db.js';

process.env.LOG_LEVEL = 'silent';
const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 20 });
const noHealth = { check: async () => ({ ok: true, checkedAt: '', dependencies: {} as never }), close: async () => {} };
let app: FastifyInstance;
let doctorId: string;
let patients: string[];

const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, body?: object) =>
  app.inject({ method, url, payload: body, headers: { 'idempotency-key': randomUUID() } });
const get = async <T>(url: string) => (await app.inject({ method: 'GET', url })).json<T>();

/** Local (IST) calendar date n days from today, YYYY-MM-DD. */
const localDate = (n: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(Date.now() + n * 86_400_000),
  );
/** UTC instant of a local IST date + "HH:MM". */
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();

async function slotAt(date: string, hhmm: string) {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM slots WHERE doctor_id = $1 AND kind = 'base' AND lower(during) = $2::timestamptz`,
    [doctorId, ist(date, hhmm)],
  );
  return rows[0]?.id;
}
async function book(date: string, hhmm: string, patient: string, minutes: 15 | 30 = 15) {
  const h = (await send('POST', '/holds', { slotId: await slotAt(date, hhmm), patientId: patient, durationMinutes: minutes })).json<Hold>();
  return (await send('POST', '/appointments', { holdId: h.holdId, visitType: 'in_person' })).json<Appointment>();
}
const D1 = localDate(2); // a day safely in the future (changes apply from tomorrow)
const D2 = localDate(3);

beforeAll(async () => {
  app = await buildApp({ pool, health: noHealth, webOrigin: 'x' });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

// A fresh doctor and fresh patients per test (a patient booked in one test would be "busy" in the next):
// every day 09:00-13:00 IST, 14 days materialized.
beforeEach(async () => {
  patients = (
    await pool.query<{ id: string }>(
      `INSERT INTO patients (name, phone)
       SELECT 'Doc' || i, '+9176' || floor(random() * 1e8)::bigint FROM generate_series(1, 6) i RETURNING id`,
    )
  ).rows.map((r) => r.id);
  doctorId = (
    await pool.query<{ id: string }>(
      `INSERT INTO doctors (name, specialty, clinic, area, lat, lng) VALUES ('Dr. Week', 'ENT', 'C', 'Jayanagar', 12.93, 77.58) RETURNING id`,
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO schedule_templates (doctor_id, weekday, start_local, end_local, slot_minutes, valid_from)
     SELECT $1, wd, '09:00', '13:00', 15, current_date - 1 FROM generate_series(1, 7) wd`,
    [doctorId],
  );
  await materializeSlots(pool, { doctorIds: [doctorId], days: 14 });
});

const statusAt = async (date: string, hhmm: string) =>
  (await pool.query<{ status: string; blocked_reason: string | null }>(
    'SELECT status, blocked_reason FROM slots WHERE id = $1',
    [await slotAt(date, hhmm)],
  )).rows[0];

describe('week view', () => {
  it('shows 7 days, with a 30-minute booking as one block (startsHere) and the patient name', async () => {
    await book(D1, '10:00', patients[0], 30);
    const monday = new Date(`${D1}T00:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const week = await get<WeekView>(`/doctors/${doctorId}/week?start=${monday.toISOString().slice(0, 10)}`);
    expect(week.days).toHaveLength(7);
    const day = week.days.find((d) => d.date === D1)!;
    const at = (t: string) => day.slots.find((s) => s.localTime === t)!;
    expect(at('10:00')).toMatchObject({ status: 'booked', appointment: { patientName: 'Doc1', minutes: 30, startsHere: true } });
    expect(at('10:15')).toMatchObject({ status: 'booked', appointment: { startsHere: false } });
    expect(at('10:30')).toMatchObject({ status: 'open', appointment: null });
  });

  it('rejects a start that is not a Monday', async () => {
    expect((await app.inject({ method: 'GET', url: `/doctors/${doctorId}/week?start=2030-01-08` })).statusCode).toBe(422);
  });
});

describe('working hours (decision 1a: keep and flag bookings)', () => {
  it('shrinking hours closes open slots, keeps the booking (flagged), and growing them back reopens exactly those', async () => {
    await book(D1, '12:00', patients[0]);
    const shrink = await send('PUT', `/doctors/${doctorId}/templates`, {
      templates: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startLocal: '09:00', endLocal: '11:00' })),
    });
    expect(shrink.statusCode).toBe(200);
    const r = shrink.json();
    expect(r.keptBookingsOutsideHours).toBe(1);
    expect(r.blockedSlots).toBeGreaterThan(0);
    expect(await statusAt(D1, '12:15')).toEqual({ status: 'blocked', blocked_reason: 'hours' });
    expect(await statusAt(D1, '12:00')).toMatchObject({ status: 'booked' }); // kept
    expect(await statusAt(D1, '10:00')).toMatchObject({ status: 'open' });

    const back = (
      await send('PUT', `/doctors/${doctorId}/templates`, {
        templates: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startLocal: '09:00', endLocal: '13:00' })),
      })
    ).json();
    expect(back.reopenedSlots).toBe(r.blockedSlots);
    expect(await statusAt(D1, '12:15')).toEqual({ status: 'open', blocked_reason: null });
  });

  it('new hours create new slots (materialized in the same transaction) and an event for search/live', async () => {
    const res = (
      await send('PUT', `/doctors/${doctorId}/templates`, {
        templates: [1, 2, 3, 4, 5, 6, 7].flatMap((weekday) => [
          { weekday, startLocal: '09:00', endLocal: '13:00' },
          { weekday, startLocal: '16:00', endLocal: '17:00' },
        ]),
      })
    ).json();
    expect(res.addedSlots).toBeGreaterThanOrEqual(13 * 4); // 4 afternoon slots on each of >= 13 days
    expect(await statusAt(D1, '16:00')).toMatchObject({ status: 'open' });
    const ev = await pool.query(`SELECT payload FROM outbox WHERE doctor_id = $1 AND event_type = 'schedule.changed'`, [doctorId]);
    expect(ev.rows[0].payload).toMatchObject({ reason: 'hours', addedSlots: res.addedSlots });
  });

  it('validates the rules', async () => {
    const bad = (templates: object[]) => send('PUT', `/doctors/${doctorId}/templates`, { templates });
    expect((await bad([{ weekday: 1, startLocal: '13:00', endLocal: '09:00' }])).statusCode).toBe(422);
    expect((await bad([{ weekday: 1, startLocal: '09:10', endLocal: '10:00' }])).statusCode).toBe(422);
    expect(
      (await bad([{ weekday: 1, startLocal: '09:00', endLocal: '12:00' }, { weekday: 1, startLocal: '11:00', endLocal: '13:00' }])).statusCode,
    ).toBe(422);
  });
});

describe('time off (decision 2a: preview, then cancel + notify)', () => {
  it('preview lists exactly the bookings that would be cancelled', async () => {
    await book(D1, '10:00', patients[0]);
    await book(D2, '10:00', patients[1]);
    const r = await get<{ affectedAppointments: { patientName: string }[] }>(
      `/doctors/${doctorId}/time-off/preview?start=${D1}T09:00&end=${D1}T13:00`,
    );
    expect(r.affectedAppointments.map((a) => a.patientName)).toEqual(['Doc1']);
  });

  it('cancels bookings (by doctor), releases holds, blocks slots, and emits the events', async () => {
    const appt = await book(D1, '10:00', patients[0]);
    const held = (await send('POST', '/holds', { slotId: await slotAt(D1, '11:00'), patientId: patients[1] })).json<Hold>();

    const res = await send('POST', `/doctors/${doctorId}/time-off`, { start: `${D1}T09:00`, end: `${D1}T13:00`, kind: 'leave', reason: 'Conference' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ blockedSlots: 16, releasedHolds: 1, cancelledAppointments: [{ id: appt.id, patientName: 'Doc1' }] });

    const a = await pool.query('SELECT status, cancelled_by, cancel_reason FROM appointments WHERE id = $1', [appt.id]);
    expect(a.rows[0]).toEqual({ status: 'cancelled', cancelled_by: 'doctor', cancel_reason: 'Conference' });
    expect(await statusAt(D1, '10:00')).toEqual({ status: 'blocked', blocked_reason: 'time_off' });
    expect((await send('POST', `/holds/${held.holdId}/heartbeat`)).statusCode).toBe(404); // the hold is gone
    expect((await send('POST', '/holds', { slotId: await slotAt(D1, '12:00'), patientId: patients[2] })).statusCode).toBe(409);

    const events = await pool.query<{ event_type: string; payload: { cancelledBy?: string } }>(
      `SELECT event_type, payload FROM outbox WHERE doctor_id = $1 AND created_at >= now() - interval '1 minute' ORDER BY id`,
      [doctorId],
    );
    const types = events.rows.map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['hold.released', 'appointment.cancelled', 'schedule.changed']));
    expect(events.rows.find((e) => e.event_type === 'appointment.cancelled' && e.payload.cancelledBy)?.payload.cancelledBy).toBe('doctor');
  });

  it('the patient is told the doctor is unavailable (not the generic message)', async () => {
    await book(D1, '10:00', patients[3]);
    await send('POST', `/doctors/${doctorId}/time-off`, { start: `${D1}T09:00`, end: `${D1}T13:00`, kind: 'leave' });
    const { rows } = await pool.query(
      `SELECT id::text AS "eventId", event_type AS "eventType", doctor_id AS "doctorId", aggregate_id AS "aggregateId",
              created_at AS "occurredAt", payload
         FROM outbox WHERE doctor_id = $1 AND event_type = 'appointment.cancelled' ORDER BY id DESC LIMIT 1`,
      [doctorId],
    );
    await handleNotifierEvents(pool, async () => 0, [{ key: doctorId, value: JSON.stringify(rows[0]) }]);
    const n = await pool.query(`SELECT title FROM notifications WHERE patient_id = $1 AND kind = 'cancelled' ORDER BY created_at DESC LIMIT 1`, [patients[3]]);
    expect(n.rows[0].title).toMatch(/unavailable/i);
  });

  it('removing the time off reopens the slots (cancelled bookings stay cancelled)', async () => {
    const appt = await book(D1, '10:00', patients[0]);
    const t = (await send('POST', `/doctors/${doctorId}/time-off`, { start: `${D1}T09:00`, end: `${D1}T13:00`, kind: 'leave' })).json();
    const res = await send('DELETE', `/doctors/${doctorId}/time-off/${t.timeOff.id}`);
    expect(res.statusCode).toBe(200);
    expect(await statusAt(D1, '10:00')).toEqual({ status: 'open', blocked_reason: null });
    const a = await pool.query('SELECT status FROM appointments WHERE id = $1', [appt.id]);
    expect(a.rows[0].status).toBe('cancelled');
  });

  it('race: 30-minute holds and time off at the same moment never leave a hold inside the time off', async () => {
    for (let round = 0; round < 8; round++) {
      const day = localDate(4 + round);
      const results = await Promise.all([
        send('POST', `/doctors/${doctorId}/time-off`, { start: `${day}T09:00`, end: `${day}T13:00`, kind: 'blocked' }),
        send('POST', '/holds', { slotId: await slotAt(day, '10:00'), patientId: patients[4], durationMinutes: 30 }),
        send('POST', '/holds', { slotId: await slotAt(day, '11:00'), patientId: patients[5], durationMinutes: 30 }),
      ]);
      expect(results[0].statusCode).toBe(201);
    }
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM slots s
        WHERE s.doctor_id = $1 AND s.status IN ('held', 'booked')
          AND EXISTS (SELECT 1 FROM schedule_exceptions e WHERE e.doctor_id = s.doctor_id AND e.during && s.during)`,
      [doctorId],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('visit outcomes and numbers', () => {
  it('outcomes only after the visit started; stats count offered, booked, cancellations and no-shows', async () => {
    // A visit that already started (inserted directly: the API won't hold the past).
    const past = await pool.query<{ id: string }>(
      `INSERT INTO slots (doctor_id, during, status) VALUES ($1, tstzrange(now() - interval '1 hour', now() - interval '45 minutes'), 'open') RETURNING id`,
      [doctorId],
    );
    const pastAppt = await pool.query<{ id: string }>(
      `INSERT INTO appointments (slot_id, doctor_id, patient_id, visit_type, idempotency_key)
       VALUES ($1, $2, $3, 'in_person', gen_random_uuid()::text) RETURNING id`,
      [past.rows[0].id, doctorId, patients[0]],
    );
    await pool.query(`UPDATE slots SET status = 'booked', appointment_id = $2 WHERE id = $1`, [past.rows[0].id, pastAppt.rows[0].id]);

    const future = await book(D1, '10:00', patients[1]);
    expect((await send('POST', `/appointments/${future.id}/no-show`)).statusCode).toBe(409); // not started yet
    expect((await send('POST', `/appointments/${pastAppt.rows[0].id}/no-show`)).json().status).toBe('no_show');

    const cancelled = await book(D1, '11:00', patients[2]);
    await send('POST', `/appointments/${cancelled.id}/cancel`);

    const s = await get<DoctorStats>(`/doctors/${doctorId}/stats?from=${D1}&to=${D1}`);
    expect(s).toMatchObject({
      offeredMinutes: 240, // 09:00-13:00
      bookedMinutes: 15,
      utilizationPct: 6.3,
      appointments: 1,
      cancellations: 1,
      cancellationRatePct: 50,
    });
    expect(s.byDay).toEqual([{ date: D1, offeredMinutes: 240, bookedMinutes: 15 }]);

    const today = localDate(0);
    const t = await get<DoctorStats>(`/doctors/${doctorId}/stats?from=${today}&to=${today}`);
    expect([t.noShows, t.noShowRatePct]).toEqual([1, 100]);
  });
});
