// Graceful shutdown (Phase 6): in-flight requests finish, new connections are refused, long-lived streams are cut
// after the drain window, then cleanup runs and the process "exits".
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { gracefulShutdown } from '../src/shutdown.js';

async function serverWithSlowRoute() {
  const app = Fastify();
  app.get('/slow', async () => {
    await new Promise((r) => setTimeout(r, 800));
    return { done: true };
  });
  app.get('/stream', (_req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.raw.write(': connected\n\n'); // never ends on its own, like SSE
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

describe('graceful shutdown', () => {
  it('lets an in-flight request finish, refuses new connections, then cleans up and exits 0', async () => {
    const { app, url } = await serverWithSlowRoute();
    const events: string[] = [];
    const shutdown = gracefulShutdown(app, {
      drainMs: 2000,
      log: () => {},
      cleanup: async () => void events.push('cleanup'),
      exit: (code) => void events.push(`exit ${code}`),
    });

    const inFlight = fetch(`${url}/slow`).then(async (r) => ({ status: r.status, body: await r.json() }));
    await new Promise((r) => setTimeout(r, 100)); // the request is now being processed
    const done = shutdown('SIGTERM');

    await new Promise((r) => setTimeout(r, 100));
    const late = await fetch(`${url}/slow`, { signal: AbortSignal.timeout(1000) }).then(
      (r) => r.status,
      () => 'refused',
    );

    expect(await inFlight).toEqual({ status: 200, body: { done: true } }); // finished, not cut off
    expect(late).toBe('refused'); // a load balancer would now retry on the other instance
    await done;
    expect(events).toEqual(['cleanup', 'exit 0']);
  });

  it('cuts never-ending streams after the drain window instead of hanging forever', async () => {
    const { app, url } = await serverWithSlowRoute();
    const events: string[] = [];
    const ctrl = new AbortController();
    const res = await fetch(`${url}/stream`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    await reader.read(); // ": connected"

    const t0 = Date.now();
    await gracefulShutdown(app, {
      drainMs: 300,
      log: () => {},
      cleanup: async () => void events.push('cleanup'),
      exit: (code) => void events.push(`exit ${code}`),
    })('SIGTERM');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(events).toEqual(['cleanup', 'exit 0']);
    ctrl.abort();
  });

  it('a second signal does not start a second shutdown', async () => {
    const { app } = await serverWithSlowRoute();
    let exits = 0;
    const shutdown = gracefulShutdown(app, { log: () => {}, cleanup: async () => {}, exit: () => void exits++ });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(exits).toBe(1);
  });
});
