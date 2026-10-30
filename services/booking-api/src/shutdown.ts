// Graceful shutdown: Phase 6's critical piece. Akshay chose mode C (Claude writes it and walks through it, and
// Akshay answers review questions before it is committed).
//
// Goal: restart an API instance during live traffic (a deploy) with ZERO failed requests.
// Together with the nginx config (infra/nginx/cluster.conf):
//   1. app.close() stops accepting new connections. nginx's connect to this instance fails, so nginx sends
//      the request to the other instance instead.
//   2. A request arriving on an already-open keep-alive connection gets a 503 + "Connection: close" (Fastify's
//      return503OnClosing). nginx retries it on the other instance.
//   3. Requests already in flight are allowed to FINISH; app.close() waits for them.
//   4. Long-lived SSE streams never finish on their own, so after `drainMs` they are cut. EventSource reconnects
//      by itself, through nginx, to the instance that's still up.
//   5. Then background work and connections are closed (sweeper, Redis, Postgres), and the process exits.
// Retrying a POST (step 1/2) is only safe because every write carries an Idempotency-Key.
import type { FastifyInstance } from 'fastify';

export interface ShutdownOptions {
  /** How long in-flight requests get before long-lived connections (SSE) are cut. */
  drainMs?: number;
  /** Hard cap: if shutdown hangs, give up and exit anyway. */
  hardTimeoutMs?: number;
  /** Close everything else, after HTTP is done: sweeper, Redis subscriber, health clients, Postgres pool. */
  cleanup: () => Promise<void>;
  log: (msg: string) => void;
  exit?: (code: number) => void;
}

export function gracefulShutdown(app: FastifyInstance, opts: ShutdownOptions) {
  const { drainMs = 5_000, hardTimeoutMs = 15_000, cleanup, log, exit = (c) => process.exit(c) } = opts;
  let started = false;

  return async (signal: string) => {
    if (started) return; // a second Ctrl+C doesn't start a second shutdown
    started = true;
    const t0 = Date.now();
    log(`${signal}: draining (new connections refused, in-flight requests finish)`);

    const hardStop = setTimeout(() => {
      log(`shutdown took over ${hardTimeoutMs} ms, exiting anyway`);
      exit(1);
    }, hardTimeoutMs);
    hardStop.unref();

    // Long-lived connections (SSE) would keep app.close() waiting forever: cut them after the drain window.
    const cutLongLived = setTimeout(() => {
      log(`drain window (${drainMs} ms) over: closing remaining connections (SSE clients will reconnect elsewhere)`);
      app.server.closeAllConnections();
    }, drainMs);
    cutLongLived.unref();

    try {
      await app.close(); // stops listening, 503s new requests on open connections, waits for in-flight ones
      clearTimeout(cutLongLived);
      await cleanup();
      log(`shutdown complete in ${Date.now() - t0} ms`);
      clearTimeout(hardStop);
      exit(0);
    } catch (err) {
      log(`shutdown error: ${(err as Error).message}`);
      exit(1);
    }
  };
}
