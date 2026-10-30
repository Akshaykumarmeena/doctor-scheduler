// Server-Sent Events: a long-lived HTTP response the server keeps writing "event: ...\ndata: ...\n\n" frames to.
// One-way (server -> browser), plain HTTP, and the browser's EventSource reconnects by itself.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { LiveSlotEvent } from '@ds/shared';
import type { Pool } from '../db.js';
import type { LiveHub } from '../live/hub.js';
import { notFound } from '../errors.js';

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const HEARTBEAT_MS = 15_000; // keeps proxies from closing an idle connection
// Heartbeat the BROWSER can see (comment lines like ": ping" are invisible to EventSource): plain "message" frames,
// "hello" right after connecting and "ping" every 15 s. If a page hears neither, the stream is blocked somewhere
// (e.g. the free Cloudflare quick tunnel) and the page falls back to polling (apps/web/app/live.ts).
const HELLO = 'data: hello\n\n';
const PING = ': ping\ndata: ping\n\n';

async function openStream(
  req: FastifyRequest,
  reply: FastifyReply,
  webOrigin: string,
  hub: LiveHub,
  channel: string,
  toFrame: (message: string) => string | null,
) {
  reply.hijack(); // we write the raw response ourselves from here on
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': webOrigin,
  });
  // Listen for the browser leaving first, so a disconnect during the subscribe below still cleans up.
  let closed = false;
  let cleanup = () => {};
  req.raw.on('close', () => {
    closed = true;
    cleanup();
  });
  // Subscribe BEFORE telling the client it's connected: Redis pub/sub drops messages nobody is subscribed to,
  // so anything published after ": connected" must already have a listener.
  const unsubscribe = await hub.subscribe(channel, (message) => {
    const frame = toFrame(message);
    if (frame) reply.raw.write(frame);
  });
  const heartbeat = setInterval(() => reply.raw.write(PING), HEARTBEAT_MS);
  cleanup = () => {
    clearInterval(heartbeat);
    void unsubscribe();
  };
  if (closed) return cleanup();
  reply.raw.write(': connected\n\n');
  reply.raw.write(HELLO);
}

export function registerStreamRoutes(app: FastifyInstance, deps: { pool: Pool; hub: LiveHub; webOrigin: string }) {
  app.get<{ Params: { id: string }; Querystring: { date?: string } }>(
    '/doctors/:id/slots/stream',
    {
      schema: {
        params: idParams,
        querystring: { type: 'object', properties: { date: { type: 'string', format: 'date' } } },
      },
    },
    async (req, reply) => {
      const { rows } = await deps.pool.query<{ tz: string }>('SELECT tz FROM doctors WHERE id = $1', [req.params.id]);
      if (!rows[0]) throw notFound('doctor_not_found', 'No such doctor');
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: rows[0].tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      const { date } = req.query;

      await openStream(req, reply, deps.webOrigin, deps.hub, `doctor:${req.params.id}`, (message) => {
        const event = JSON.parse(message) as LiveSlotEvent;
        // Only forward changes on the day this page shows (events without a time always pass).
        if (date && event.start && day.format(new Date(event.start)) !== date) return null;
        return `event: slots-changed\ndata: ${message}\n\n`;
      });
    },
  );

  app.get<{ Params: { id: string } }>('/patients/:id/stream', { schema: { params: idParams } }, async (req, reply) => {
    await openStream(req, reply, deps.webOrigin, deps.hub, `patient:${req.params.id}`, (message) => `event: notification\ndata: ${message}\n\n`);
  });
}
