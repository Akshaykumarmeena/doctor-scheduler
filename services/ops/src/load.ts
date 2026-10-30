// Load tests: k6 runs in Docker (image grafana/k6, nothing installed on the Mac) against the API on :4000. With
// rollingRestart, the two API instances are restarted one after the other DURING the run, the way a deploy
// would, and the run shows whether any request failed.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import type { LoadRun } from '@ds/shared';
import type { ProcessControl } from './supervisor.js';
import { checkInvariants } from './invariants.js';

export const K6_IMAGE = 'grafana/k6:0.54.0';

/**
 * After an instance is healthy, wait this long before stopping the next one. "Healthy" means the process answers;
 * it is not yet "back in rotation": nginx re-tries an instance it saw fail only after fail_timeout (2 s). Stopping
 * the other instance inside that window left nginx with no live upstream (502s), measured at 0.5-3.4% errors with
 * browser tabs open (their live-update streams make each drain take the full 5 s). Same idea as Kubernetes'
 * minReadySeconds.
 */
export const ROTATION_SETTLE_MS = 3000;

export interface LoadOptions {
  vus: number;
  durationSec: number;
  rollingRestart: boolean;
}

interface K6Summary {
  metrics: Record<string, Record<string, number>>;
}

export function loadRunner(deps: { repoRoot: string; processes: ProcessControl; pool: pg.Pool; log: (l: string) => void }) {
  const runs = new Map<string, LoadRun>();
  const outDir = path.join(deps.repoRoot, 'loadtest/out');

  async function rollingRestart(run: LoadRun, t0: number) {
    const at = () => Math.round((Date.now() - t0) / 1000);
    for (const name of ['api-1', 'api-2'] as const) {
      run.restartTimeline.push({ atSec: at(), event: `${name}: SIGTERM (drain, then exit)` });
      await deps.processes.stop(name);
      run.restartTimeline.push({ atSec: at(), event: `${name}: stopped, starting again` });
      await deps.processes.start(name);
      const ok = await deps.processes.waitHealthy(name);
      run.restartTimeline.push({ atSec: at(), event: `${name}: ${ok ? 'healthy' : 'did NOT come back healthy'}` });
      if (ok && name === 'api-1') {
        await new Promise((r) => setTimeout(r, ROTATION_SETTLE_MS));
        run.restartTimeline.push({ atSec: at(), event: `${name}: back in rotation (waited ${ROTATION_SETTLE_MS / 1000} s for nginx)` });
      }
    }
  }

  return {
    get: (runId: string) => runs.get(runId),

    async start(opts: LoadOptions): Promise<LoadRun> {
      if ([...runs.values()].some((r) => r.status === 'running')) throw new Error('busy');
      if (opts.rollingRestart && !deps.processes.managed) throw new Error('cluster_not_running');
      await mkdir(outDir, { recursive: true });

      const run: LoadRun = {
        runId: randomUUID().slice(0, 8),
        status: 'running',
        ...opts,
        startedAt: new Date().toISOString(),
        rps: null,
        p50: null,
        p95: null,
        p99: null,
        errorRate: null,
        checksPassed: null,
        restartTimeline: [],
        invariantsAfter: null,
      };
      runs.set(run.runId, run);

      const args = [
        'run', '--rm',
        '--add-host=host.docker.internal:host-gateway',
        '-v', `${path.join(deps.repoRoot, 'loadtest')}:/loadtest`,
        '-e', 'BASE_URL=http://host.docker.internal:4000',
        '-e', `VUS=${opts.vus}`,
        '-e', `DURATION=${opts.durationSec}s`,
        K6_IMAGE,
        'run', '--quiet',
        '--summary-trend-stats=avg,med,p(95),p(99),max',
        '--summary-export', `/loadtest/out/${run.runId}.json`,
        '/loadtest/booking.js',
      ];
      const t0 = Date.now();
      const k6 = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      k6.stdout.on('data', (b: Buffer) => deps.log(`[k6 ${run.runId}] ${b.toString().trim()}`));
      k6.stderr.on('data', (b: Buffer) => deps.log(`[k6 ${run.runId}] ${b.toString().trim()}`));

      // Restart about a third of the way in, so there is load before, during and after.
      if (opts.rollingRestart) {
        setTimeout(() => {
          rollingRestart(run, t0).catch((e) => run.restartTimeline.push({ atSec: -1, event: `restart failed: ${(e as Error).message}` }));
        }, Math.round(opts.durationSec * 300));
      }

      k6.on('exit', async (code) => {
        try {
          const summary = JSON.parse(await readFile(path.join(outDir, `${run.runId}.json`), 'utf8')) as K6Summary;
          const m = summary.metrics;
          const round = (n: number | undefined) => (n === undefined ? null : Math.round(n * 10) / 10);
          run.rps = round(m.http_reqs?.rate);
          run.p50 = round(m.http_req_duration?.med);
          run.p95 = round(m.http_req_duration?.['p(95)']);
          run.p99 = round(m.http_req_duration?.['p(99)']);
          run.errorRate = round((m.http_req_failed?.value ?? 0) * 100);
          run.checksPassed = round((m.checks?.value ?? 0) * 100);
          run.status = 'done';
          // k6 exits 99 when a threshold failed: the run itself still completed.
          if (code !== 0 && code !== 99) run.error = `k6 exited with ${code}`;
        } catch (e) {
          run.status = 'failed';
          run.error = `no k6 summary (exit ${code}): ${(e as Error).message}`;
        }
        run.invariantsAfter = await checkInvariants(deps.pool).catch(() => null);
      });
      return run;
    },
  };
}

/** True once the k6 image is available locally (the first run pulls it, ~60 MB). */
export function k6ImagePresent(): Promise<boolean> {
  return new Promise((resolve) => execFile('docker', ['image', 'inspect', K6_IMAGE], (err) => resolve(!err)));
}
