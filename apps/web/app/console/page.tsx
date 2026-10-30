'use client';

// Engineering console (Phase 6): see the system's guarantees under stress, from one page.
// Talks to the dev-only ops service on :4100 (started by `npm run dev:cluster`).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConsumerLag, Invariants, LoadRun, OpsService, RaceResult } from '@ds/shared';

const OPS = process.env.NEXT_PUBLIC_OPS_URL ?? 'http://localhost:4100';

async function ops<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${OPS}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message ?? `HTTP ${res.status}`);
  return json as T;
}

interface FeedEvent {
  offset: string;
  partition: number;
  eventType: string;
  doctorId: string | null;
  occurredAt: string | null;
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * The console drives the dev-only ops service (stop Redis, restart APIs...). Over the public demo link it must do
 * nothing: it shows a notice and never calls the ops service. (The ops service itself also only listens on
 * 127.0.0.1, so a remote visitor couldn't reach it anyway.)
 */
export default function ConsolePage() {
  const [where, setWhere] = useState<'checking' | 'local' | 'public'>('checking');
  useEffect(() => setWhere(LOCAL_HOSTS.includes(window.location.hostname) ? 'local' : 'public'), []);
  if (where === 'checking') return null;
  if (where === 'public') {
    return (
      <main className="wide">
        <h1>Engineering console</h1>
        <section className="panel">
          <p>The console is local only: it controls services on the presenter&apos;s machine.</p>
          <p className="muted small">Everything else (search, booking, the doctor app) works on this link.</p>
        </section>
      </main>
    );
  }
  return <Console />;
}

function Console() {
  const [services, setServices] = useState<OpsService[] | null>(null);
  const [opsDown, setOpsDown] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [races, setRaces] = useState<{ api?: RaceResult; naive?: RaceResult }>({});
  const [lag, setLag] = useState<ConsumerLag[]>([]);
  const [inv, setInv] = useState<Invariants | null>(null);
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [load, setLoad] = useState<LoadRun | null>(null);
  const [vus, setVus] = useState(20);
  const [duration, setDuration] = useState(30);
  const [rolling, setRolling] = useState(true);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([ops<OpsService[]>('/ops/services'), ops<Invariants>('/ops/invariants')]);
      setServices(s);
      setInv(i);
      setOpsDown(false);
      ops<{ consumers: ConsumerLag[] }>('/ops/consumers').then((r) => setLag(r.consumers), () => setLag([]));
    } catch {
      setOpsDown(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const es = new EventSource(`${OPS}/ops/events/stream`);
    es.addEventListener('kafka', (e) => setFeed((f) => [JSON.parse((e as MessageEvent).data) as FeedEvent, ...f].slice(0, 60)));
    return () => es.close();
  }, []);

  useEffect(() => () => void (poll.current && clearInterval(poll.current)), []);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage((e as Error).message);
    }
    setBusy(null);
    refresh();
  };

  const race = (mode: 'api' | 'naive') =>
    act(`race-${mode}`, async () => {
      const result = await ops<RaceResult>('/ops/race', { mode });
      setRaces((r) => ({ ...r, [mode]: result }));
    });

  const startLoad = () =>
    act('load', async () => {
      const run = await ops<LoadRun>('/ops/load', { vus, durationSec: duration, rollingRestart: rolling });
      setLoad(run);
      if (poll.current) clearInterval(poll.current);
      poll.current = setInterval(async () => {
        const r = await ops<LoadRun>(`/ops/load/${run.runId}`);
        setLoad(r);
        if (r.status !== 'running' && r.invariantsAfter && poll.current) clearInterval(poll.current);
      }, 2000);
    });

  if (opsDown) {
    return (
      <main className="wide">
        <h1>Engineering console</h1>
        <section className="panel">
          <p>The ops service isn't running. Stop `npm run dev` and start the cluster instead:</p>
          <pre>npm run dev:cluster</pre>
          <p className="muted small">It runs two booking-api instances behind nginx on :4000, the workers, the web app, and the dev-only ops service on :4100.</p>
        </section>
      </main>
    );
  }

  const invRows: [keyof Invariants, string, boolean][] = [
    ['doubleBookings', 'Double bookings (same doctor, overlapping)', true],
    ['patientOverlaps', 'Patient in two places at once', true],
    ['holdsInTimeOff', 'Holds or bookings inside time off', true],
    ['expiredHoldsNotSwept', 'Expired holds not swept (> 30 s)', true],
    ['outboxBacklog', 'Outbox backlog (events waiting for the relay)', false],
  ];

  return (
    <main className="wide">
      <h1>Engineering console</h1>
      {message && <p className="error">{message}</p>}

      <section className="panel">
        <h2>Services</h2>
        <div className="tiles">
          {services?.map((s) => (
            <div key={s.name} className="tile">
              <div className="controls">
                <span className={s.healthy ? 'dot ok' : 'dot down'} aria-hidden />
                <strong>{s.name}</strong>
                <span className="muted small">{s.kind} · {s.status}</span>
              </div>
              {s.controllable ? (
                s.status === 'up' ? (
                  <button disabled={!!busy} onClick={() => act(s.name, () => ops(`/ops/services/${s.name}/stop`, {}))}>Stop</button>
                ) : (
                  <button disabled={!!busy} onClick={() => act(s.name, () => ops(`/ops/services/${s.name}/start`, {}))}>Start</button>
                )
              ) : (
                <span className="muted small">{s.name === 'postgres' ? 'source of truth: not stoppable' : 'not supervised'}</span>
              )}
              {busy === s.name && <span className="muted small"> working…</span>}
            </div>
          ))}
        </div>
        <p className="muted small">Try: stop redis (live updates pause, booking works) · stop opensearch (search 503, booking works) · stop api-1 (nginx sends everything to api-2).</p>
      </section>

      <section className="panel">
        <h2>Guarantees (live)</h2>
        <ul className="list">
          {invRows.map(([k, label, mustBeZero]) => {
            const v = inv ? (inv[k] as number) : null;
            return (
              <li key={k} className="controls">
                <span className={v === 0 || !mustBeZero ? 'dot ok' : 'dot down'} aria-hidden />
                <span className="name">{label}</span>
                <strong>{v ?? '…'}</strong>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="panel">
        <h2>Race: 100 patients, one slot</h2>
        <div className="controls">
          <button disabled={!!busy} onClick={() => race('api')}>Through the API</button>
          <button disabled={!!busy} onClick={() => race('naive')}>Naive check-then-act</button>
        </div>
        <div className="tiles">
          {races.api && (
            <div className="tile">
              <div className="muted small">API · {races.api.slot}</div>
              <div className="value">{races.api.held} held / {races.api.rejected} rejected</div>
              <div className="muted small">{races.api.other} other · {races.api.ms} ms</div>
            </div>
          )}
          {races.naive && (
            <div className="tile">
              <div className="muted small">Naive · {races.naive.slot}</div>
              <div className="value">{races.naive.naiveToldYes} told "yes"</div>
              <div className="muted small">row overwritten {races.naive.overwrites}× · {races.naive.ms} ms</div>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <h2>Load test (k6)</h2>
        <div className="controls">
          <label>VUs <input type="number" min={1} max={100} value={vus} onChange={(e) => setVus(Number(e.target.value))} /></label>
          <label>Seconds <input type="number" min={10} max={120} value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></label>
          <label><input type="checkbox" checked={rolling} onChange={(e) => setRolling(e.target.checked)} /> rolling restart during the run</label>
          <button className="primary" disabled={!!busy || load?.status === 'running'} onClick={startLoad}>Run</button>
        </div>
        {load && (
          <>
            <p className="small">
              Run {load.runId}: <strong>{load.status}</strong>
              {load.status === 'running' && ' (the first run pulls the k6 image, ~60 MB)'}
              {load.error && <span className="error"> · {load.error}</span>}
            </p>
            {load.rps !== null && (
              <div className="tiles">
                {[
                  ['Requests/s', load.rps],
                  ['p50 ms', load.p50],
                  ['p95 ms', load.p95],
                  ['p99 ms', load.p99],
                  ['Errors %', load.errorRate],
                  ['Checks passed %', load.checksPassed],
                ].map(([l, v]) => (
                  <div key={l as string} className="tile">
                    <div className="muted small">{l}</div>
                    <div className="value">{v ?? '–'}</div>
                  </div>
                ))}
              </div>
            )}
            {load.restartTimeline.length > 0 && (
              <ul className="list small">
                {load.restartTimeline.map((t, i) => <li key={i}>t+{t.atSec}s · {t.event}</li>)}
              </ul>
            )}
            {load.invariantsAfter && (
              <p className="small">
                After the run: double bookings <strong>{load.invariantsAfter.doubleBookings}</strong> · patient overlaps{' '}
                <strong>{load.invariantsAfter.patientOverlaps}</strong>
              </p>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Consumer lag</h2>
        <ul className="list">
          {lag.map((g) => (
            <li key={g.groupId} className="controls">
              <span className={g.totalLag === 0 ? 'dot ok' : 'dot down'} aria-hidden />
              <span className="name">{g.groupId}</span>
              <strong>{g.totalLag}</strong>
              <span className="muted small">{g.partitions.map((p) => `p${p.partition}:${p.lag}`).join(' ')}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Live events (topic "appointments")</h2>
        {feed.length === 0 && <p className="muted">Waiting for events… book or cancel something.</p>}
        <ul className="list small">
          {feed.map((e) => (
            <li key={`${e.partition}-${e.offset}`}>
              <code>{e.eventType}</code> · p{e.partition}@{e.offset} · doctor {e.doctorId?.slice(0, 8)} ·{' '}
              {e.occurredAt && new Date(e.occurredAt).toLocaleTimeString()}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
