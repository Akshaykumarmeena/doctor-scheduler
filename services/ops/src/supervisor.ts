// Supervises the cluster's local processes (npm run dev:cluster): two booking-api instances behind nginx, plus the
// workers. "Stop" sends SIGTERM, so the process shuts down gracefully (booking-api drains in-flight requests),
// and only escalates to SIGKILL if it doesn't exit in time.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { ProcessName } from './guard.js';

interface Spec {
  cwd: string;
  args: string[];
  env: Record<string, string>;
  healthUrl?: string;
}

export interface ProcessControl {
  managed: boolean;
  status(name: ProcessName): Promise<{ up: boolean; healthy: boolean }>;
  stop(name: ProcessName): Promise<void>;
  start(name: ProcessName): Promise<void>;
  /** Waits until the process answers its health URL (or is merely running, if it has none). */
  waitHealthy(name: ProcessName, timeoutMs?: number): Promise<boolean>;
  stopAll(): Promise<void>;
}

const STOP_TIMEOUT_MS = 20_000;

export function processSupervisor(repoRoot: string, log: (line: string) => void): ProcessControl {
  const api = (port: number): Spec => ({
    cwd: path.join(repoRoot, 'services/booking-api'),
    args: ['src/server.ts'],
    env: { API_PORT: String(port) },
    healthUrl: `http://127.0.0.1:${port}/health`,
  });
  const specs: Record<ProcessName, Spec> = {
    'api-1': api(4001),
    'api-2': api(4002),
    // Workers talk to the API through the load balancer, like any client.
    workers: { cwd: path.join(repoRoot, 'services/workers'), args: ['src/index.ts'], env: { API_URL: 'http://localhost:4000' } },
  };
  const children = new Map<ProcessName, ChildProcess>();

  const start = async (name: ProcessName) => {
    if (children.get(name)?.exitCode === null) return; // already running
    const spec = specs[name];
    // The local tsx binary directly (not via npx), so SIGTERM reaches the app and it can shut down gracefully.
    const child = spawn(path.join(repoRoot, 'node_modules/.bin/tsx'), spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const prefix = (chunk: Buffer) => chunk.toString().split('\n').filter(Boolean).forEach((l) => log(`[${name}] ${l}`));
    child.stdout?.on('data', prefix);
    child.stderr?.on('data', prefix);
    child.on('exit', (code, signal) => log(`[${name}] exited (${signal ?? code})`));
    children.set(name, child);
  };

  const stop = async (name: ProcessName) => {
    const child = children.get(name);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM'); // graceful: booking-api drains in-flight requests first
    const killer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(killer);
  };

  const healthy = async (name: ProcessName) => {
    const child = children.get(name);
    const up = !!child && child.exitCode === null && child.signalCode === null;
    const url = specs[name].healthUrl;
    if (!up || !url) return { up, healthy: up };
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      return { up, healthy: res.status === 200 || res.status === 503 }; // 503 = a dependency is down, but it serves
    } catch {
      return { up, healthy: false };
    }
  };

  return {
    managed: true,
    status: healthy,
    start,
    stop,
    async waitHealthy(name, timeoutMs = 60_000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if ((await healthy(name)).healthy) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    },
    async stopAll() {
      await Promise.all((Object.keys(specs) as ProcessName[]).map(stop));
    },
  };
}

/** Plain `npm run dev`: processes aren't ours to control. */
export const unmanagedProcesses: ProcessControl = {
  managed: false,
  status: async () => ({ up: false, healthy: false }),
  stop: async () => {},
  start: async () => {},
  waitHealthy: async () => false,
  stopAll: async () => {},
};
