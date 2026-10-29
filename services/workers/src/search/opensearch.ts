// A tiny OpenSearch REST client over fetch: every request is visible JSON, no SDK magic (same idea as plain SQL).

export class OpenSearchError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    what: string,
  ) {
    super(`${what} failed: HTTP ${status} ${JSON.stringify(body).slice(0, 300)}`);
  }
}

export async function os<T = unknown>(
  baseUrl: string,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const ndjson = Array.isArray(body); // the _bulk API takes newline-delimited JSON
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': ndjson ? 'application/x-ndjson' : 'application/json' },
    body: body === undefined ? undefined : ndjson ? (body as unknown[]).map((l) => JSON.stringify(l)).join('\n') + '\n' : JSON.stringify(body),
  });
  const text = method === 'HEAD' ? '' : await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** Like os(), but throws on any non-2xx. */
export async function osOk<T = unknown>(...args: Parameters<typeof os>): Promise<T> {
  const res = await os<T>(...args);
  if (res.status >= 300) throw new OpenSearchError(res.status, res.body, `${args[1]} ${args[2]}`);
  return res.body;
}
