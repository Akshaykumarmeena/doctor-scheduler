import type { ApiError } from '@ds/shared';

// Same origin: the browser calls /api/..., and Next.js forwards it to booking-api (next.config.ts). That way the app
// also works through a public tunnel, where "localhost:4000" would mean the VISITOR's machine.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '/api';

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
  }
}

/**
 * Calls booking-api. Writes pass an idempotency key: generate one per user action and reuse it if the
 * same action is retried, so a double-click or a network retry can never create two bookings.
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: 'no-store',
  });
  const body = await res.json();
  if (!res.ok) throw new ApiFailure(res.status, body as ApiError);
  return body as T;
}
