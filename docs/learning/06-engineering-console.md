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
