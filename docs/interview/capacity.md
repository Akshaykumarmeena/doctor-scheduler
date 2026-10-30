# Capacity estimates: India scale

> **Akshay's piece (mode B).** The assumptions and the structure are filled in. **You do the math**: replace every
> `___` with a number and one line of working. Round aggressively; interviewers want orders of magnitude and clear
> reasoning, not precision. Rules of thumb: 1 day ≈ 10⁵ s (86,400); peak ≈ 3–5× the average; 1 KB × 1 M = 1 GB.

## 1. Assumptions (given: change them if you disagree, and say why)

| | Value | Why |
| --- | --- | --- |
| Doctors on the platform | 500,000 | India has ~1.3 M registered allopathic doctors; assume ~40% join |
| Patients (registered) | 100 M | large consumer health apps reach this order |
| Bookings per day (average) | 2 M | ~2% of patients book something on a given day… roughly |
| Searches per booking | 10 | people compare doctors and times |
| Slot-grid views per booking | 5 | |
| Busy hours | 4 hours carry 50% of the day's traffic | mornings and evenings |
| Slot length / working day | 15 min, 8 h | → 32 slots per doctor per day |
| Materialized horizon | 60 days | (14 in the demo) |
| Row sizes | slot ~150 B, appointment ~300 B, event ~1 KB, search doc ~2 KB | with indexes, ×2–3 |

## 2. Traffic

| Quantity | Your math | Result |
| --- | --- | --- |
| Average bookings/s | 2 M / 10⁵ s | `___` |
| Peak bookings/s (busy hours) | 50% of 2 M in 4 h = 1 M / (4 × 3,600) | `___` |
| Each booking = hold + confirm (+ ~10% retries/cancels): peak **write** requests/s | | `___` |
| Peak **search** requests/s | peak bookings/s × 10 | `___` |
| Peak **slot-grid** reads/s | peak bookings/s × 5 | `___` |
| Read : write ratio | | `___ : 1` |

## 3. Storage (per year, before replication)

| Quantity | Your math | Result |
| --- | --- | --- |
| Slots alive at once | 500 k doctors × 32 slots/day × 60 days × 150 B | `___ GB` |
| Appointments per year | 2 M/day × 365 × 300 B | `___ GB/year` |
| Outbox / Kafka events per year | (bookings + cancels + holds ≈ 4 events per booking) × 1 KB | `___ TB/year` (keep 7 days in Kafka → `___ GB`) |
| Search index | 500 k doctors × 2 KB | `___ GB` (tiny: fits in RAM) |

## 4. What that means for each component (fill in, then defend)

| Component | Question | Your answer |
| --- | --- | --- |
| Postgres | Can one primary take `___` writes/s at peak? (a well-tuned primary: ~5–10 k simple writes/s) | `___` |
| Postgres | When must we shard, and by what key? (hint: what does every booking query filter on?) | `___` |
| Postgres | How many shards for 3× headroom? | `___` |
| Kafka | Partitions for `___` events/s at peak, if one consumer handles ~1–2 k/s? Keyed by? | `___` |
| OpenSearch | Searches/s per node (~1–2 k simple queries/s): how many nodes + replicas? | `___` |
| Redis | Live-update messages/s = events/s × open pages per doctor: is one node enough? | `___` |
| booking-api | Requests/s per instance (~1–2 k/s for light JSON + 1 DB round trip): how many instances? | `___` |

## 5. The one-minute answer (write it last, in your own words)

> "At India scale that's roughly `___` bookings/s at peak and `___` reads/s, about `___`:1 read-heavy. Reads go to
> OpenSearch and caches; writes stay in Postgres, sharded by `___` because `___`. Kafka with `___` partitions keyed
> by doctor keeps per-doctor ordering. The hard part isn't throughput, it's `___`."

---
*When you're done, tell Claude "check capacity". It'll review your numbers and reasoning, not rewrite them.*
