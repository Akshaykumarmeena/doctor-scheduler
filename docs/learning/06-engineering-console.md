# Phase 6 – The engineering console: proving it under stress

Everything so far claimed guarantees. This phase makes them **visible on demand**: one page (`/console`, with
`npm run dev:cluster`) where you can race 100 patients, kill dependencies, watch every event, and load-test
while "deploying".

## 1. What's on the page

| Panel | What it proves |
| --- | --- |
| Services: stop/start Redis, Redpanda, OpenSearch, api-1, api-2, workers | booking keeps working when parts fail (Postgres can't be stopped: it is the truth) |
| Guarantees (live SQL) | double bookings, patient overlaps, holds inside time off: always 0 |
| Race | through the API: 1 winner, 99 × 409 · naive check-then-act: many told "yes" |
| Consumer lag | each consumer group's backlog; stop OpenSearch and watch search-indexer's lag grow, start it and watch it drain |
| Live events | every Kafka event as it happens |
| Load test (k6) | throughput, p50/p95/p99, error rate, with an optional rolling restart mid-run |

## 2. Load-testing vocabulary

- **VU** (virtual user): a loop doing what a patient does (search, look at slots, book, cancel) with think time.
- **RPS**: requests per second. Here ~60 with 20 VUs, because each VU sleeps between requests, like a human.
- **p50 / p95 / p99**: 50%, 95%, 99% of requests were faster than this. **Averages lie**: one slow request in
  20 is invisible in the mean but obvious at p95. SLOs are written on percentiles ("p95 < 300 ms").
- **Thresholds** make the test pass or fail automatically: CI-able performance.
- **409 is not an error** under contention: losing a race correctly is the system working.

## 3. Zero-downtime restart (Akshay's piece, mode C)

A deploy replaces running instances. Two halves:

**The instance leaves politely** (`booking-api/src/shutdown.ts`). On SIGTERM it:
1. stops accepting new connections,
2. answers requests on already-open connections with 503 "Connection: close",
3. lets in-flight requests finish,
4. after 5 s cuts long-lived SSE streams (browsers reconnect elsewhere),
5. closes the sweeper, Redis and Postgres, and exits. A 15 s hard cap means it can never hang forever.

**The load balancer routes around it** (`infra/nginx/cluster.conf`): a refused connection, timeout, 502 or 503 is
retried once on the other instance, **even for POST**.

Why is retrying a POST safe here? Normally it isn't: "book" sent twice books twice. Our writes carry an
**Idempotency-Key**: if the first attempt actually ran, the retry replays its stored answer; if it never ran
(refused connection), the retry runs it once. Idempotency keys are what make automatic retries safe. That is the
link between Phase 2 and Phase 6.

Result on your Mac: both instances restarted mid-run, **0% errors**, p95 unchanged (39 ms vs 38 ms), nginx logged
9 refused connections, every one retried successfully.

## 4. The bug the load test found

The first run had 5% errors. The cause wasn't the API: `host.docker.internal` resolves to an IPv4 **and** an
unreachable IPv6 address, and nginx treats every address as a separate server, so about half its "servers" were
dead the whole time. Fix: resolve the IPv4 address at container start. Lesson: **load tests find infrastructure
bugs unit tests never will**, and you must read the error breakdown, not just the headline number. (It also
surfaced a bug in the load script itself, and one in the API's error handler; see the ROADMAP log.)

## 4b. The second bug: "healthy" is not "back in rotation" (found 2026-10-30)

The 0% above was measured with nobody using the app. With browser tabs open, the same test showed **0.5–3.4%
errors**. Two things combined:
1. Every open page keeps a live-update stream (SSE). So an instance now takes the full 5 s to drain instead of
   stopping at once.
2. The rolling restart stopped api-2 the moment api-1 answered its health check. But nginx had marked api-1 as
   failed while it was restarting, and only tries it again after `fail_timeout` (2 s). Inside that window api-2
   started draining too, so nginx saw **no live upstream** and answered 502 itself (its log says exactly that).

Proof by hand, same load: restart api-2 right after api-1 is healthy → 1.5% errors (a timing race: another run got
0%); wait 4 s first → 0% and 0%. Fixed in two places (Akshay chose both):
- **The orchestrator waits** 3 s after an instance is healthy before stopping the next (`ROTATION_SETTLE_MS` in
  `services/ops/src/load.ts`). Kubernetes calls this `minReadySeconds`; cloud load balancers use a "healthy
  threshold" of N good checks.
- **nginx never marks an instance down** (`max_fails=0` in `cluster.conf`): a failure is simply retried on the
  other one, so "no live upstreams" can't happen. The cost: a request may try a dying instance first (instant on a
  refused connection; up to `proxy_connect_timeout` if a host hangs).

After the fix, with 4 streams held open (every drain took the full 5 s): **3 runs, 0% errors, 100% checks**.
Lessons: measure with realistic clients connected (idle-system results can lie), and a health check answers "is the
process up?", not "is the load balancer sending it traffic?".

## 5. Consumer lag, live

Lag = newest offset − committed offset. Stop OpenSearch, make a few bookings: search-indexer's lag climbs (its
batches keep failing and retrying), the other groups stay at 0 (independent groups, failure isolation). Start
OpenSearch: lag drains to 0, and nothing was lost.

## 6. Interview lines

- "We prove guarantees with live invariant checks under load, not just unit tests."
- "Zero-downtime deploys: graceful drain on SIGTERM plus load-balancer retries. Retrying non-idempotent requests
  is only safe because writes carry idempotency keys."
- "Watch p95/p99, not averages; 409s under contention are correct answers."
- "Consumer lag per group shows exactly which downstream is behind, and that the others are unaffected."
