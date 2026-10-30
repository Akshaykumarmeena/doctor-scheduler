// The ops HTTP API used by the /console page. Dependencies are injected so tests can swap Docker, the process
// supervisor and Kafka for fakes.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import type pg from 'pg';
import type { OpsService } from '@ds/shared';
import { CONTAINERS, PROCESSES, isContainer, isProcess } from './guard.js';
import type { DockerControl } from './docker.js';
import type { ProcessControl } from './supervisor.js';
import type { KafkaView } from './kafka.js';
import { checkInvariants } from './invariants.js';
import { raceNaive, raceViaApi } from './race.js';
import type { loadRunner } from './load.js';

export interface OpsDeps {
  pool: pg.Pool;
  docker: DockerControl;
  processes: ProcessControl;
  kafka: KafkaView | null;
  load: ReturnType<typeof loadRunner> | null;
  apiUrl: string;
  webOrigin: string;
}

class OpsError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function buildOpsApp(deps: OpsDeps) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });
  await app.register(cors, { origin: deps.webOrigin, methods: ['GET', 'POST'] });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof OpsError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    const e = err as { validation?: unknown; message: string };
    if (e.validation) return reply.code(400).send({ error: 'invalid_request', message: e.message });
    return reply.code(500).send({ error: 'internal', message: e.message });
  });

  app.get('/ops/services', async (): Promise<OpsService[]> => {
    const containers = await Promise.all(
      (Object.keys(CONTAINERS) as (keyof typeof CONTAINERS)[]).map(async (name) => {
        const s = await deps.docker.status(name).catch(() => ({ up: false, healthy: false }));
        return { name, kind: 'container' as const, status: s.up ? ('up' as const) : ('down' as const), healthy: s.healthy, controllable: CONTAINERS[name] };
      }),
    );
    const processes = await Promise.all(
      PROCESSES.map(async (name) => {
        const s = await deps.processes.status(name);
        return { name, kind: 'process' as const, status: s.up ? ('up' as const) : ('down' as const), healthy: s.healthy, controllable: deps.processes.managed };
      }),
    );
    return [...containers, ...processes];
  });

  app.post<{ Params: { name: string; action: 'stop' | 'start' } }>(
    '/ops/services/:name/:action',
    { schema: { params: { type: 'object', properties: { name: { type: 'string' }, action: { type: 'string', enum: ['stop', 'start'] } } } } },
    async (req) => {
      const { name, action } = req.params;
      if (isContainer(name)) {
        if (!CONTAINERS[name]) throw new OpsError(403, 'not_allowed', `${name} is the source of truth and can't be stopped from the console`);
        await deps.docker[action](name);
      } else if (isProcess(name)) {
        if (!deps.processes.managed) throw new OpsError(409, 'cluster_not_running', 'Processes are only controllable under npm run dev:cluster');
        await deps.processes[action](name);
      } else {
        throw new OpsError(404, 'unknown_service', `No such service: ${name}`);
      }
      return { name, action, ok: true };
    },
  );

  app.post<{ Body: { mode: 'api' | 'naive'; racers?: number } }>(
    '/ops/race',
    {
      schema: {
        body: {
          type: 'object',
          required: ['mode'],
          additionalProperties: false,
          properties: { mode: { type: 'string', enum: ['api', 'naive'] }, racers: { type: 'integer', minimum: 10, maximum: 200 } },
        },
      },
    },
    async (req) => {
      const racers = req.body.racers ?? 100;
      return req.body.mode === 'api' ? raceViaApi(deps.pool, deps.apiUrl, racers) : raceNaive(deps.pool, racers);
    },
  );

  app.get('/ops/events/stream', async (req, reply) => {
    if (!deps.kafka) throw new OpsError(503, 'kafka_unavailable', 'The event feed needs Redpanda');
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': deps.webOrigin,
    });
    for (const e of deps.kafka.recent().slice(-50)) reply.raw.write(`event: kafka\ndata: ${JSON.stringify(e)}\n\n`);
    const off = deps.kafka.onEvent((e) => reply.raw.write(`event: kafka\ndata: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      off();
      clearInterval(ping);
    });
  });

  app.get('/ops/consumers', async () => {
    if (!deps.kafka) throw new OpsError(503, 'kafka_unavailable', 'Consumer lag needs Redpanda');
    return { consumers: await deps.kafka.lag() };
  });

  app.get('/ops/invariants', async () => checkInvariants(deps.pool));

  app.post<{ Body: { vus: number; durationSec: number; rollingRestart: boolean } }>(
    '/ops/load',
    {
      schema: {
        body: {
          type: 'object',
          required: ['vus', 'durationSec', 'rollingRestart'],
          additionalProperties: false,
          properties: {
            vus: { type: 'integer', minimum: 1, maximum: 100 },
            durationSec: { type: 'integer', minimum: 10, maximum: 120 },
            rollingRestart: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      if (!deps.load) throw new OpsError(503, 'load_unavailable', 'Load tests are not available');
      try {
        return reply.code(202).send(await deps.load.start(req.body));
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === 'busy') throw new OpsError(409, 'load_busy', 'A load test is already running');
        if (msg === 'cluster_not_running') throw new OpsError(409, 'cluster_not_running', 'A rolling restart needs npm run dev:cluster');
        throw e;
      }
    },
  );

  app.get<{ Params: { runId: string } }>('/ops/load/:runId', async (req) => {
    const run = deps.load?.get(req.params.runId);
    if (!run) throw new OpsError(404, 'run_not_found', 'No such load run');
    return run;
  });

  return app;
}
