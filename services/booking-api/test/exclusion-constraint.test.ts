// Proves the database itself refuses double bookings, independent of any application code.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../../../test/test-db.js';

const client = new pg.Client({ connectionString: testDatabaseUrl() });
let doctorId: string;
let otherDoctorId: string;
let patientId: string;

beforeAll(() => client.connect());
afterAll(() => client.end());

// Each test runs in a transaction that is rolled back, so tests never see each other's rows.
beforeEach(async () => {
  await client.query('BEGIN');
  const doctors = await client.query<{ id: string }>(
    `INSERT INTO doctors (name, specialty, clinic, area, lat, lng)
     VALUES ('Dr. A', 'Cardiology', 'Clinic A', 'Indiranagar', 12.97, 77.64),
            ('Dr. B', 'Cardiology', 'Clinic B', 'Indiranagar', 12.97, 77.64)
     RETURNING id`,
  );
  [doctorId, otherDoctorId] = doctors.rows.map((r) => r.id);
  const patient = await client.query<{ id: string }>(
    `INSERT INTO patients (name, phone) VALUES ('Test Patient', '+919999999999') RETURNING id`,
  );
  patientId = patient.rows[0].id;
});
afterEach(() => client.query('ROLLBACK'));

/** A fresh patient per booking, so these doctor-overlap tests aren't tripped by the per-patient rule (Phase 4). */
async function newPatient() {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO patients (name, phone) VALUES ('Test Patient', '+91' || floor(random() * 1e10)::bigint) RETURNING id`,
  );
  return rows[0].id;
}

/** Inserts an open slot, then (optionally) books it through a real appointment row. */
async function slot(doctor: string, range: string, status: 'open' | 'held' | 'booked' = 'open') {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO slots (doctor_id, during) VALUES ($1, $2::tstzrange) RETURNING id`,
    [doctor, range],
  );
  const slotId = rows[0].id;
  if (status === 'held') {
    await client.query(
      `UPDATE slots SET status = 'held', hold_id = gen_random_uuid(), hold_patient_id = $2,
              hold_expires_at = now() + interval '5 minutes'
        WHERE id = $1`,
      [slotId, patientId],
    );
  } else if (status === 'booked') {
    const appt = await client.query<{ id: string }>(
      `INSERT INTO appointments (slot_id, doctor_id, patient_id, visit_type, idempotency_key)
       VALUES ($1, $2, $3, 'in_person', gen_random_uuid()::text) RETURNING id`,
      [slotId, doctor, await newPatient()],
    );
    await client.query(`UPDATE slots SET status = 'booked', appointment_id = $2 WHERE id = $1`, [slotId, appt.rows[0].id]);
  }
  return slotId;
}

// Savepoint so an expected error does not abort the surrounding test transaction.
async function expectExclusionViolation(fn: () => Promise<unknown>) {
  await client.query('SAVEPOINT attempt');
  const err = await fn().then(() => null, (e: pg.DatabaseError) => e);
  await client.query('ROLLBACK TO SAVEPOINT attempt');
  expect(err, 'expected the insert/update to be rejected').not.toBeNull();
  expect(err?.code).toBe('23P01'); // exclusion_violation
  expect(err?.constraint).toBe('slots_no_overlapping_commitments');
}

// 09:00-09:15, 09:15-09:30 and 09:00-09:30 IST on 2 Nov 2026, written in UTC.
const NINE = '[2026-11-02 03:30Z, 2026-11-02 03:45Z)';
const NINE_FIFTEEN = '[2026-11-02 03:45Z, 2026-11-02 04:00Z)';
const NINE_TO_NINE_THIRTY = '[2026-11-02 03:30Z, 2026-11-02 04:00Z)';

describe('slots exclusion constraint', () => {
  it('rejects a 30-min booking that overlaps an existing 15-min booking with a different start time', async () => {
    await slot(doctorId, NINE_FIFTEEN, 'booked');
    await expectExclusionViolation(() => slot(doctorId, NINE_TO_NINE_THIRTY, 'booked'));
  });

  it('rejects a hold that overlaps a booking', async () => {
    await slot(doctorId, NINE, 'booked');
    await expectExclusionViolation(() => slot(doctorId, NINE_TO_NINE_THIRTY, 'held'));
  });

  it('allows adjacent bookings because ranges are half-open [start, end)', async () => {
    await slot(doctorId, NINE, 'booked');
    await expect(slot(doctorId, NINE_FIFTEEN, 'booked')).resolves.toBeTypeOf('string');
  });

  it('allows overlapping OPEN slots (only held/booked rows are policed)', async () => {
    await slot(doctorId, NINE);
    await slot(doctorId, NINE_FIFTEEN);
    await expect(slot(doctorId, NINE_TO_NINE_THIRTY)).resolves.toBeTypeOf('string');
  });

  it('allows the same time for two different doctors', async () => {
    await slot(doctorId, NINE, 'booked');
    await expect(slot(otherDoctorId, NINE, 'booked')).resolves.toBeTypeOf('string');
  });
});
