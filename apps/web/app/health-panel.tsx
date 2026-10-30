'use client';

import { useEffect, useState } from 'react';
import type { DependencyName, HealthReport } from '@ds/shared';
import { API_URL } from './api';

const POLL_MS = 5000;
const LABELS: Record<DependencyName, string> = {
  postgres: 'Postgres',
  redis: 'Redis',
  redpanda: 'Redpanda (Kafka API)',
  opensearch: 'OpenSearch',
};

export function HealthPanel() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // /health answers 503 with a full report when a dependency is down, so read the body either way.
        const res = await fetch(`${API_URL}/health`, { cache: 'no-store' });
        const body = (await res.json()) as HealthReport;
        if (!cancelled) {
          setReport(body);
          setApiError(null);
        }
      } catch (err) {
        if (!cancelled) setApiError(`booking-api unreachable at ${API_URL} (${(err as Error).message})`);
      }
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <section className="panel" aria-live="polite">
      <h2>
        System health{' '}
        {report && !apiError && <span className={report.ok ? 'badge ok' : 'badge down'}>{report.ok ? 'all up' : 'degraded'}</span>}
      </h2>
      {apiError && <p className="error">{apiError}</p>}
      {!report && !apiError && <p className="muted">Checking…</p>}
      {report && (
        <ul>
          {(Object.keys(LABELS) as DependencyName[]).map((name) => {
            const dep = report.dependencies[name];
            return (
              <li key={name}>
                <span className={dep?.ok ? 'dot ok' : 'dot down'} aria-hidden />
                <span className="name">{LABELS[name]}</span>
                <span className="muted">{dep?.ok ? `${dep.latencyMs} ms` : dep?.error ?? 'unknown'}</span>
              </li>
            );
          })}
        </ul>
      )}
      {report && <p className="muted small">Last checked {new Date(report.checkedAt).toLocaleTimeString()} · refreshes every 5 s</p>}
    </section>
  );
}
