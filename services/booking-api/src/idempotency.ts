// Idempotency-Key handling. The key row, the business change and the stored response are written in
// ONE transaction, so either all of them exist or none do:
//
//   BEGIN
//   INSERT INTO idempotency_keys (key, request_hash) ... ON CONFLICT DO NOTHING
//     -> inserted: we own the key; run the handler on this same transaction, store its response, COMMIT
//     -> conflict: someone already used the key; replay their stored response (or 422 if the body differs)
//
// Two concurrent requests with the same key: the second INSERT blocks on the first one's uncommitted
// row (unique index), then sees the committed row and replays it. If the first rolls back, the second
// proceeds as the owner. No "in progress" state is ever visible.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Pool } from './db.js';
import { HttpError, badRequest, unprocessable } from './errors.js';

export interface IdempotentResult {
  statusCode: number;
  body: unknown;
}

export type Tx = pg.PoolClient;

export function requestHash(method: string, url: string, body: unknown) {
  return createHash('sha256').update(`${method} ${url}\n${JSON.stringify(body ?? null)}`).digest('hex');
}

export function requireKey(header: string | string[] | undefined): string {
  const key = Array.isArray(header) ? header[0] : header;
  if (!key || key.length > 200) throw badRequest('idempotency_key_required', 'Idempotency-Key header (1-200 chars) is required');
  return key;
}

/**
 * Runs `handler` exactly once per key. 2xx and 4xx outcomes are stored and replayed on retry;
 * unexpected errors roll everything back so the client can retry with the same key.
 */
export async function withIdempotency(
  pool: Pool,
  key: string,
  hash: string,
  handler: (tx: Tx) => Promise<IdempotentResult>,
): Promise<IdempotentResult & { replayed: boolean }> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const claimed = await tx.query(
      `INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key, hash],
    );

    if (claimed.rowCount === 0) {
      const { rows } = await tx.query<{ request_hash: string; status_code: number; response: unknown }>(
        'SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1',
        [key],
      );
      await tx.query('ROLLBACK');
      if (rows[0].request_hash !== hash) {
        throw unprocessable('idempotency_key_reused', 'This Idempotency-Key was already used with a different request');
      }
      return { statusCode: rows[0].status_code, body: rows[0].response, replayed: true };
    }

    let result: IdempotentResult;
    try {
      await tx.query('SAVEPOINT handler');
      result = await handler(tx);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      // A business rejection (e.g. 409 slot taken): undo the handler's partial work, keep the key,
      // and remember the answer so a retry gets the same one.
      await tx.query('ROLLBACK TO SAVEPOINT handler');
      result = { statusCode: err.statusCode, body: { error: err.code, message: err.message } };
    }

    await tx.query('UPDATE idempotency_keys SET status_code = $2, response = $3 WHERE key = $1', [
      key,
      result.statusCode,
      JSON.stringify(result.body),
    ]);
    await tx.query('COMMIT');
    return { ...result, replayed: false };
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}
