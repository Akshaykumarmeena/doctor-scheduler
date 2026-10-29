# 0009 – A dev-only ops console, and zero-downtime restarts

Status: accepted (Phase 6, 2026-10-29; decisions by Akshay: separate ops service, k6 via Docker, cluster setup,
graceful shutdown + retry policy as his piece in mode C)

## Context

The system's guarantees (no double booking, booking survives component failures, safe retries) should be
demonstrable on demand: under concurrency, under load, and while a "deploy" restarts the API.

## Decisions

1. **A separate ops service** (`services/ops`, :4100) drives the console. It controls Docker and local processes,
   so it is dev-only by construction: it refuses to start without `OPS_ENABLED=1` (and with
   `NODE_ENV=production`), binds to 127.0.0.1, uses `execFile` with whitelisted names (no shell, no free-form
   commands), and never stops Postgres. Ops endpoints are never added to booking-api.
2. **Cluster mode** (`npm run dev:cluster`): the ops service supervises api-1 (:4001), api-2 (:4002) and the
   workers; an nginx container on :4000 balances the two APIs. `npm run dev` is unchanged.
3. **Graceful shutdown** (`booking-api/src/shutdown.ts`): on SIGTERM, stop accepting connections, 503 new
   requests on open keep-alive connections, let in-flight requests finish, cut long-lived SSE streams after a 5 s
   drain window (EventSource reconnects through nginx), then close the sweeper, Redis and Postgres. A 15 s hard cap
   prevents hanging.
4. **Retry policy** (`infra/nginx/cluster.conf`): on connect error, timeout, 502 or 503, retry once on the other
   instance, **including POST** (`non_idempotent`). That is safe only because every write carries an
   Idempotency-Key.
5. **nginx targets the Mac's IPv4 address**, resolved at container start (`resolve-api-host.sh`).
   `host.docker.internal` also resolves to an IPv6 address that is unreachable from the container, and nginx
   treats every resolved address as a separate server. The first load test failed 5% of requests because of it.
6. **k6 runs in Docker** (`grafana/k6:0.54.0`, pinned). 409 counts as an expected answer (lost a race), not an
   error. Thresholds: p95 < 300 ms, errors < 1%.
7. **Live invariants** are plain SQL the console polls: double bookings, patient overlaps, holds inside time off,
   unswept expired holds (all must be 0) and the outbox backlog.

## Consequences

- Measured on Akshay's Mac (20 VUs): baseline p95 38 ms, 0% errors; with both APIs restarted mid-run: p95 39 ms,
  **0% errors**, 0 double bookings. nginx logged 9 refused connections during the restarts, all retried successfully.
- The console is a demo and debugging tool only; production would use real orchestration (health-checked
  rolling deploys) and metrics/alerting instead.
