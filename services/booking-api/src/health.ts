// Reachability probes for every dependency the platform will rely on.
import { Redis } from 'ioredis';
import { Kafka, logLevel, type Admin } from 'kafkajs';
import type { DependencyHealth, DependencyName, HealthReport } from '@ds/shared';
import type { Pool } from './db.js';

const TIMEOUT_MS = 2000;

export interface HealthDeps {
  pool: Pool;
  redisUrl: string;
  kafkaBrokers: string[];
  opensearchUrl: string;
}

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function probe(fn: () => Promise<unknown>): Promise<DependencyHealth> {
  const started = performance.now();
  try {
    await withTimeout(fn());
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return { ok: false, latencyMs: Math.round(performance.now() - started), error: (err as Error).message };
  }
}

export function createHealthChecker(deps: HealthDeps) {
  // Long-lived clients: opening a fresh connection per /health call would hide pool problems
  // and make the endpoint slow.
  const redis = new Redis(deps.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  redis.on('error', () => {}); // surfaced through the probe instead of crashing the process
  const kafka = new Kafka({ clientId: 'booking-api-health', brokers: deps.kafkaBrokers, logLevel: logLevel.NOTHING, retry: { retries: 0 } });
  let admin: Admin | null = null;

  const checks: Record<DependencyName, () => Promise<unknown>> = {
    postgres: () => deps.pool.query('SELECT 1'),
    redis: async () => {
      if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
      const pong = await redis.ping();
      if (pong !== 'PONG') throw new Error(`unexpected reply ${pong}`);
    },
    redpanda: async () => {
      try {
        if (!admin) {
          admin = kafka.admin();
          await admin.connect();
        }
        await admin.describeCluster();
      } catch (err) {
        await admin?.disconnect().catch(() => {});
        admin = null;
        throw err;
      }
    },
    opensearch: async () => {
      const res = await fetch(`${deps.opensearchUrl}/_cluster/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { status: string };
      if (body.status === 'red') throw new Error('cluster status red');
    },
  };

  return {
    async check(): Promise<HealthReport> {
      const names = Object.keys(checks) as DependencyName[];
      const results = await Promise.all(names.map((n) => probe(checks[n])));
      const dependencies = Object.fromEntries(names.map((n, i) => [n, results[i]])) as HealthReport['dependencies'];
      return { ok: results.every((r) => r.ok), checkedAt: new Date().toISOString(), dependencies };
    },
    async close() {
      redis.disconnect();
      await admin?.disconnect().catch(() => {});
    },
  };
}

export type HealthChecker = ReturnType<typeof createHealthChecker>;
