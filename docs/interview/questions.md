# Likely interview questions, with crisp answers

Collected from all phases' study notes and Akshay's review answers. Practise saying each answer out loud in about
30 seconds.

## Correctness

**How do you prevent double booking?**
A Postgres exclusion constraint: `EXCLUDE USING gist (doctor_id WITH =, during WITH &&) WHERE status IN ('held','booked')`.
No two live commitments of one doctor can overlap, enforced by the database for every writer. On top of that, a
hold is a single conditional UPDATE (`WHERE status = 'open'`), so racers on the same row serialize and exactly one wins.

**Why not `UNIQUE(doctor_id, start_time)`?**
It only catches identical starts. A 30-minute visit at 09:00 and a 15-minute one at 09:15 have different starts
but overlap. EXCLUDE compares ranges.

**100 users click the same slot at once. What happens?**
All 100 run `UPDATE … WHERE id = $1 AND status = 'open'`. The first takes the row lock and commits; the others wait,
re-check the WHERE against the new row, match 0 rows and get 409. Measured: 1 held, 99 rejected. The naive
read-then-write version told 60 people "yes".

**What's the difference between the exclusion constraint and the conditional UPDATE?**
EXCLUDE stops *different* rows overlapping; the conditional UPDATE stops writers fighting over the *same* row. You
need both.

**Row locks: what can't they protect?**
Rows that don't exist yet. A 30-minute hold inserts a new row; the time-off transaction couldn't lock it. The fix
is to lock an existing parent (the base slots, FOR SHARE), or rely on a constraint that sees inserts.

## Reliability and events

**The client times out and retries a booking. Double booking?**
No. Every write carries an Idempotency-Key, stored with the effect and the response in one transaction. The retry
replays the stored answer. That's also what makes load-balancer retries of POST safe.

**How do you publish events without losing or inventing any?**
Transactional outbox: the event row is written in the same transaction as the change; a relay publishes it to Kafka
afterwards and marks it published. Delivery is at-least-once, so consumers are idempotent (dedupe keys, or rebuild
from the source of truth).

**FOR UPDATE vs FOR UPDATE SKIP LOCKED?**
Plain FOR UPDATE waits, and with `LIMIT 1` can return zero rows after the wait (the row no longer matches). SKIP
LOCKED skips busy rows and takes the next, which is right for work queues: the waitlist matcher, the outbox relay,
the sweeper.

**Why cancel bookings inside the time-off transaction?**
All or nothing. A crash between "time off recorded" and "bookings cancelled" would leave patients booked with an
absent doctor. Events come from the same transaction, so we never notify about something that rolled back.

**Why two event types for time off?**
One event per fact. `appointment.cancelled` per patient (notifier, waitlist); `schedule.changed` per doctor
(search, live pages). Time off on an empty afternoon cancels nobody but still changes search.

## Search and read models

**Filter vs query in OpenSearch?**
Filter = yes/no, unscored, cached (specialty, language, date, distance). Query = scored relevance (free text).
Exact constraints go in filter.

**Why multiply by log(2 + rating)?**
Rating should nudge, not dominate: log compresses the 3–5 range (1.21×). The better text match stays on top; rating
breaks near-ties. log(2+·) so an unrated doctor isn't zeroed.

**How do you change a mapping without downtime?**
Build a new index behind an alias, then swap the alias atomically. Rollback = swap back.

**Search shows a slot that's actually gone. Is that a bug?**
No, it's a read model with ~1 s lag. Booking always re-checks in Postgres; the UI says "may lag".

## Operations

**How do you deploy without failing requests?**
Graceful shutdown (stop accepting, finish in-flight requests, cut long-lived streams after a drain window) plus
load-balancer retry on the other instance. Measured: both instances restarted under load, 0% errors.

**p95 vs average?**
Averages hide the slow tail; SLOs use percentiles. We gate on p95 < 300 ms.

**Consumer lag: what is it, and why per group?**
Newest offset minus committed offset. Per group because each downstream fails independently: stop OpenSearch and
only search-indexer's lag grows.

**What breaks when you shard by doctor?**
Nothing doctor-scoped. The per-patient "not in two places" constraint becomes cross-shard and moves to a
patient-keyed check.

**Your live updates go through a proxy that blocks streaming. What happens?**
The page detects it with an application-level heartbeat (a "hello" on connect, a "ping" every 15 s; a connection
being open doesn't mean data flows) and degrades from push to pull: it polls every second, and retries push every
minute. Correctness never depended on push: an update only means "refetch from the API". At scale, polling stays
cheap with 304s (ETag/version), jitter, backoff, slower polling in background tabs, and a 1–2 s cache of hot answers.

## Product

**A doctor removes Friday afternoons that already have bookings. What happens?**
Bookings are kept and flagged; only open slots close (from tomorrow). Never silently drop a patient.

**How do you rank doctors fairly by rating?**
A Bayesian average, (C·m + Σstars)/(C + n): few reviews pull toward the platform mean, many reviews dominate.
(Phase 8.)

**What happens if a user closes the tab mid-booking?**
The hold's 2-minute lease stops being renewed by heartbeats, so it lapses and the slot frees up within about 2
minutes. A hard 5-minute deadline caps every hold.
