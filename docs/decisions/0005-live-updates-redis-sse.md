# 0005 – Live updates: Kafka → one fan-out consumer → Redis pub/sub → SSE

Status: accepted (Phase 4, 2026-10-29)

## Context

When one patient holds, books or cancels, everyone looking at that doctor's day should see it without reloading,
and a patient's inbox badge should update when a message arrives. Browsers connect to any of N booking-api
instances.

## Decisions

1. **Server-Sent Events, not WebSockets.** Updates only flow server → browser. SSE is plain HTTP, works through
   proxies, and `EventSource` reconnects by itself. Endpoints: `GET /doctors/:id/slots/stream?date=` (event
   `slots-changed`, filtered to that local day) and `GET /patients/:id/stream` (event `notification`). A comment
   heartbeat every 15 s keeps idle connections open.
2. **One fan-out consumer group (`live-fanout`) publishes to Redis channels** `doctor:<id>`. Each API process
   holds ONE Redis subscriber connection shared by all its SSE clients (`LiveHub`). Any number of API instances
   works, and each browser gets the event wherever it is connected.
   *Rejected:* every API instance consuming Kafka directly (it would need a unique group per instance, and
   partition/offset bookkeeping for throwaway data).
3. **Live events are notifications, not data.** The browser refetches the grid on `slots-changed`. Redis pub/sub
   is fire-and-forget (no replay), and that's acceptable because the truth is in Postgres. `live-fanout` starts
   at the latest offset (`fromBeginning: false`), because old events are useless to a live screen.
4. **Subscribe before announcing.** The stream writes `: connected` only after the Redis SUBSCRIBE is active, so a
   message published right after a client connects is never lost. A disconnect during subscribe still cleans up.
5. **Notifications publish to `patient:<id>` after their INSERT commits** (best effort). If Redis is down the
   notification is still stored; the badge catches up on the next load.

## Consequences

- Redis down → live updates and the live badge pause; booking, search and the inbox itself keep working.
- Each open page holds one HTTP connection; at scale, that's a sizing concern for the API tier (or a dedicated
  "realtime" service).
