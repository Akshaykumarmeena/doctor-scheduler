// The race demo as a button (same idea as scripts/race.ts): N patients try to hold ONE slot at the same moment.
//   api   -> through booking-api: exactly 1 wins, the rest get 409 (winners are released afterwards)
//   naive -> the classic bug, straight against Postgres: read "open?", then write without re-checking.
//            It writes `slots` directly, which breaks invariant 1 on purpose, then resets the slot.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { RaceResult } from '@ds/shared';

async function pickSlot(pool: pg.Pool) {
  const { rows } = await pool.query<{ id: string; label: string }>(
    `SELECT s.id, d.name || ', ' || to_char(lower(s.during) AT TIME ZONE d.tz, 'Dy DD Mon HH24:MI') AS label
       FROM slots s JOIN doctors d ON d.id = s.doctor_id
      WHERE s.status = 'open' AND s.kind = 'base' AND lower(s.during) > now() + interval '1 day'
      ORDER BY lower(s.during) LIMIT 1`,
  );
  if (!rows[0]) throw new Error('No open slot found: run npm run db:seed && npm run db:materialize');
  return rows[0];
}

async function patients(pool: pg.Pool, n: number) {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM patients ORDER BY random() LIMIT $1', [n]);
  return rows.map((r) => r.id);
}

export async function raceViaApi(pool: pg.Pool, apiUrl: string, racers: number): Promise<RaceResult> {
  const slot = await pickSlot(pool);
  const ids = await patients(pool, racers);
  const started = performance.now();
  const results = await Promise.all(
    ids.map((patientId) =>
      fetch(`${apiUrl}/holds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ slotId: slot.id, patientId }),
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as { holdId?: string } })),
    ),
  );
  const ms = Math.round(performance.now() - started);
  const winners = results.filter((r) => r.status === 201);
  for (const w of winners) {
    await fetch(`${apiUrl}/holds/${w.body.holdId}`, { method: 'DELETE', headers: { 'idempotency-key': randomUUID() } });
  }
  return {
    mode: 'api',
    racers,
    slot: slot.label,
    held: winners.length,
    rejected: results.filter((r) => r.status === 409).length,
    other: results.filter((r) => r.status !== 201 && r.status !== 409).length,
    naiveToldYes: 0,
    overwrites: 0,
    ms,
  };
}

export async function raceNaive(pool: pg.Pool, racers: number): Promise<RaceResult> {
  const slot = await pickSlot(pool);
  const ids = await patients(pool, racers);
  const before = (await pool.query<{ version: number }>('SELECT version FROM slots WHERE id = $1', [slot.id])).rows[0].version;
  let toldYes = 0;
  const started = performance.now();
  try {
    await Promise.all(
      ids.map(async (patientId) => {
        const { rows } = await pool.query('SELECT status FROM slots WHERE id = $1', [slot.id]);
        if (rows[0].status !== 'open') return;
        await new Promise((r) => setTimeout(r, 20)); // app work between the read and the write
        await pool.query(
          `UPDATE slots SET status = 'held', hold_id = gen_random_uuid(), hold_patient_id = $2,
                  hold_expires_at = now() + interval '5 minutes', version = version + 1
            WHERE id = $1`, // no "AND status = 'open'": the write trusts the earlier read
          [slot.id, patientId],
        );
        toldYes++;
      }),
    );
  } finally {
    await pool.query(
      `UPDATE slots SET status = 'open', hold_id = NULL, hold_patient_id = NULL, hold_expires_at = NULL, hold_deadline_at = NULL
        WHERE id = $1`,
      [slot.id],
    );
  }
  const after = (await pool.query<{ version: number }>('SELECT version FROM slots WHERE id = $1', [slot.id])).rows[0].version;
  const overwrites = after - before;
  return {
    mode: 'naive',
    racers,
    slot: slot.label,
    held: 0,
    rejected: 0,
    other: 0,
    naiveToldYes: toldYes,
    overwrites,
    ms: Math.round(performance.now() - started),
  };
}
