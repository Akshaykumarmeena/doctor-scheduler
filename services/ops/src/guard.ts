// The ops service can stop Docker containers and local processes. It must never run anywhere but a developer's
// machine: it refuses to start without OPS_ENABLED=1, binds to 127.0.0.1 only, and only acts on whitelisted names.

export const OPS_HOST = '127.0.0.1';

export function assertOpsEnabled(env: NodeJS.ProcessEnv) {
  if (env.OPS_ENABLED !== '1') {
    throw new Error('ops service is dev-only: set OPS_ENABLED=1 to start it (never in production)');
  }
  if (env.NODE_ENV === 'production') throw new Error('ops service refuses to run with NODE_ENV=production');
}

/** Containers the console may show. Postgres is shown but never stopped: it is the source of truth. */
export const CONTAINERS = { postgres: false, redis: true, redpanda: true, opensearch: true } as const;
/** Processes the console may stop/start (only when the ops service supervises them: npm run dev:cluster). */
export const PROCESSES = ['api-1', 'api-2', 'workers'] as const;
export type ContainerName = keyof typeof CONTAINERS;
export type ProcessName = (typeof PROCESSES)[number];

export const isContainer = (name: string): name is ContainerName => name in CONTAINERS;
export const isProcess = (name: string): name is ProcessName => (PROCESSES as readonly string[]).includes(name);
