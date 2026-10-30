// Docker Compose control for whitelisted services. execFile (no shell): the service name is an argument, never
// part of a command string, so nothing can be injected.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContainerName } from './guard.js';

const run = promisify(execFile);

export interface DockerControl {
  status(name: ContainerName): Promise<{ up: boolean; healthy: boolean }>;
  stop(name: ContainerName): Promise<void>;
  start(name: ContainerName): Promise<void>;
}

export function composeDocker(repoRoot: string): DockerControl {
  const compose = (...args: string[]) => run('docker', ['compose', ...args], { cwd: repoRoot, timeout: 60_000 });
  return {
    async status(name) {
      const { stdout } = await compose('ps', '--all', '--format', 'json', name);
      const line = stdout.trim().split('\n').find(Boolean);
      if (!line) return { up: false, healthy: false };
      const c = JSON.parse(line) as { State: string; Health?: string };
      return { up: c.State === 'running', healthy: c.State === 'running' && (c.Health ? c.Health === 'healthy' : true) };
    },
    async stop(name) {
      await compose('stop', name);
    },
    async start(name) {
      await compose('start', name);
    },
  };
}
