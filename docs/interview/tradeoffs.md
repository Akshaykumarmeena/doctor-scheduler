# Trade-offs: "we chose X over Y because Z"

Each line: what we chose, what we didn't, why, and what changes at scale. Details live in `docs/decisions/`.

| Decision | Chose | Over | Because | At India scale |
| --- | --- | --- | --- | --- |
| Source of truth (0001) | Postgres | a NoSQL store | range types + EXCLUDE constraints make double-booking impossible in the DB; transactions; SKIP LOCKED | shard by `doctor_id` (every booking query filters on it; a booking never spans doctors) |
| Data access (0001) | plain SQL (`pg`) | an ORM | the interesting logic *is* SQL (EXCLUDE, conditional UPDATE, ON CONFLICT, SKIP LOCKED) | same; add query review + `pg_stat_statements` |
| Time (0001) | `tstzrange` in UTC, doctor has IANA tz | local times / start-only columns | overlap is one operator; DST-safe | same |
| Double-booking guard (0001) | EXCLUDE on `(doctor, range)` | `UNIQUE(doctor, start)` | catches overlaps with different starts (30 vs 15 min) | per shard; still exact (a doctor lives on one shard) |
| Holding a slot (0002) | a hold row with a TTL | a DB lock / Redis lock | locks can't last minutes or survive disconnects; one source of truth | same |
| Contention (0002) | conditional UPDATE (`WHERE status = 'open'`) | read-then-write | the check is atomic with the write; racers serialize on the row | same; hot doctors are single-row hot spots, which is fine |
| Retries (0002) | Idempotency-Key in the same transaction | best effort | a retry replays the answer; enables safe LB retries (0009) | TTL cleanup of keys; key scoped per client |
| Events (0002) | transactional outbox + relay | publish from the request | no dual-write gap (booked-but-no-event / event-but-no-booking) | CDC (Debezium) instead of polling at high volume |
| Delivery | at-least-once + idempotent consumers | exactly-once | far simpler; dedupe keys give exactly-once *effects* | same |
| Search (0003) | OpenSearch read model rebuilt from Postgres per event | querying Postgres / applying deltas | offloads reads; order-insensitive, idempotent rebuild | more shards/replicas; reindex via alias swap |
| 30-min visits (0004) | composite row + EXCLUDE | marking two rows under one hold | reuses the DB guarantee in both directions | same |
| Live updates (0005) | Kafka → one fan-out consumer → Redis → SSE | each API consuming Kafka; WebSockets | any number of API nodes; one-way push; auto-reconnect | dedicated realtime tier; fall back to polling when push fails |
| Waitlist (0006) | offer = a hold made through the booking API | the matcher writing slots | one code path for every guarantee | per-doctor partition ordering keeps cascades sequential |
| Abandoned holds (0007) | 2-min lease + heartbeat under a 5-min deadline | fixed TTL only / release-on-close | detects closed tabs without trusting the client | same |
| Patient overlap (0007) | EXCLUDE by patient | app-level checks | exact in one DB | **breaks when sharded by doctor**: needs a per-patient check (patient-schedule table sharded by patient, or a saga) |
| Schedule changes (0008) | one transaction; keep and flag on hours change; preview then cancel and notify on time off | silent drops / async cleanup | never surprise a patient; atomic | same |
| Deploys (0009) | graceful drain + LB retry | stop-and-restart | zero failed requests (measured) | orchestrator rolling updates + readiness probes |
| Public demo (0010) | quick tunnel + same-origin proxy + per-visitor rate limit | exposing ports / a cloud deploy | free, temporary, nothing else exposed | real hosting, auth, WAF |

## The two trade-offs to volunteer in an interview

1. **Consistency where it matters, eventual everywhere else.** Booking is strongly consistent (Postgres
   constraints); search, live updates and notifications are eventually consistent (event-driven, may lag a second).
   The UI and the booking path are designed for that: never trust the read model to decide.
2. **Sharding by doctor is natural, and it moves one guarantee.** Doctor-level guarantees stay single-shard and
   exact; the patient-level overlap guarantee must become a cross-shard check.
