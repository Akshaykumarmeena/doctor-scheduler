// Returns expired holds to 'open'. Runs inside booking-api (not services/workers) because the booking
// API is the only writer of `slots`. It is housekeeping, not correctness: createHold already treats an
// expired hold as free, so a stopped sweeper only leaves stale rows, never a stuck slot.
import type { Pool } from '../db.js';

/** One batch. SKIP LOCKED lets several API instances sweep at once without waiting on each other. */
export async function sweepExpiredHolds(pool: Pool, batchSize = 500): Promise<number> {
  const result = await pool.query(
    `WITH expired AS (
       SELECT id FROM slots
        WHERE status = 'held' AND hold_expires_at < now()
        ORDER BY hold_expires_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE slots s
        SET status = 'open', hold_id = NULL, hold_patient_id = NULL, hold_expires_at = NULL,
            version = s.version + 1, updated_at = now()
       FROM expired
      WHERE s.id = expired.id`,
    [batchSize],
  );
  return result.rowCount ?? 0;
}

export function startHoldSweeper(pool: Pool, intervalMs: number, log: (msg: string) => void) {
  const timer = setInterval(() => {
    sweepExpiredHolds(pool)
      .then((n) => n > 0 && log(`hold sweeper: released ${n} expired holds`))
      .catch((err) => log(`hold sweeper failed: ${(err as Error).message}`));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
