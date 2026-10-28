// "Break it" demo for Phase 2: 100 patients try to hold the same slot at the same moment.
//
//   npm run demo:race              -> through booking-api (needs `npm run dev`): 1 wins, 99 get 409
//   npm run demo:race -- --naive   -> the classic bug, straight against Postgres: read "is it open?",
//                                     then write without re-checking. Many "winners", last write wins.
//
// The naive mode writes `slots` directly, which breaks invariant 1 on purpose; it resets the slot after.
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DB = process.env.DATABASE_URL ?? 'postgres://scheduler:scheduler@localhost:5432/scheduler';
const API = process.env.API_URL ?? 'http://localhost:4000';
const RACERS = 100;
const naive = process.argv.includes('--naive');

// Postgres allows 100 connections and the API holds some, so cap ours. Reads still all happen before
// any write, because each racer waits 20 ms between its read and its write.
const pool = new pg.Pool({ connectionString: DB, max: 40 });

async function pickSlot() {
  const { rows } = await pool.query<{ id: string; doctor: string; local: string }>(
    `SELECT s.id, d.name AS doctor, to_char(lower(s.during) AT TIME ZONE d.tz, 'Dy DD Mon HH24:MI') AS local
       FROM slots s JOIN doctors d ON d.id = s.doctor_id
      WHERE s.status = 'open' AND lower(s.during) > now() + interval '1 day'
      ORDER BY lower(s.during) LIMIT 1`,
  );
  if (!rows[0]) throw new Error('No open slot found. Run npm run db:seed && npm run db:materialize first.');
  return rows[0];
}

async function patients() {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM patients ORDER BY id LIMIT $1', [RACERS]);
  return rows.map((r) => r.id);
}

/** What the API does: one conditional UPDATE. Postgres decides the winner atomically. */
async function viaApi(slotId: string, patientIds: string[]) {
  const results = await Promise.all(
    patientIds.map((patientId) =>
      fetch(`${API}/holds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ slotId, patientId }),
      }).then(async (r) => ({ status: r.status, body: await r.json() })),
    ),
  );
  const winners = results.filter((r) => r.status === 201);
  console.log(`  201 held:     ${winners.length}`);
  console.log(`  409 rejected: ${results.filter((r) => r.status === 409).length}`);
  const other = results.filter((r) => r.status !== 201 && r.status !== 409);
  if (other.length) console.log(`  other:        ${other.length} (e.g. ${JSON.stringify(other[0].body)})`);
  for (const w of winners) {
    await fetch(`${API}/holds/${w.body.holdId}`, { method: 'DELETE', headers: { 'idempotency-key': randomUUID() } });
  }
}

/** The bug: check, then act, with a gap in between. Every racer can see 'open' before anyone writes. */
async function naiveCheckThenAct(slotId: string, patientIds: string[]) {
  let believedTheyWon = 0;
  await Promise.all(
    patientIds.map(async (patientId) => {
      const { rows } = await pool.query('SELECT status FROM slots WHERE id = $1', [slotId]);
      if (rows[0].status !== 'open') return;
      await new Promise((r) => setTimeout(r, 20)); // app work between the read and the write
      await pool.query(
        `UPDATE slots SET status = 'held', hold_id = gen_random_uuid(), hold_patient_id = $2,
                hold_expires_at = now() + interval '5 minutes', version = version + 1
          WHERE id = $1`, // no "AND status = 'open'": the write trusts the earlier read
        [slotId, patientId],
      );
      believedTheyWon++;
    }),
  );
  const { rows } = await pool.query('SELECT version FROM slots WHERE id = $1', [slotId]);
  console.log(`  patients told "you got it": ${believedTheyWon}`);
  console.log(`  times the row was overwritten: ${rows[0].version - 1} (only the last one really holds it)`);
  await pool.query(
    `UPDATE slots SET status = 'open', hold_id = NULL, hold_patient_id = NULL, hold_expires_at = NULL WHERE id = $1`,
    [slotId],
  );
}

const slot = await pickSlot();
const racers = await patients();
console.log(`${RACERS} patients race for ${slot.doctor}, ${slot.local} (slot ${slot.id})`);
console.log(naive ? 'NAIVE check-then-act, directly in Postgres:' : 'Through booking-api POST /holds:');
try {
  await (naive ? naiveCheckThenAct(slot.id, racers) : viaApi(slot.id, racers));
} finally {
  await pool.end();
}
