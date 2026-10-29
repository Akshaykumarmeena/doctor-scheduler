# Roadmap

Agreed with Akshay on 2026-10-28. One phase = one PR, merged into `main` before the next phase starts.

## Rules

- Before any code in a phase, Claude shows a file-level plan and Akshay approves or changes it.
- **Ask before deviating from an approved plan.** If something needs to change mid-build (a new table, a moved
  component, a different behaviour), stop and ask first. Don't report it afterwards.
- **Every PR updates the "Changes vs plan" log below**, even when the answer is "none".
- Each phase has an "Akshay's piece": the critical code of that phase. Mode per phase:
  **A** Akshay writes it (hints only) · **B** pair, with blanks for Akshay · **C** Claude writes it, walks
  through it line by line, and Akshay answers review questions before it is committed.

## Phases

| # | Phase | Status | Akshay's piece (mode) |
| --- | --- | --- | --- |
| 1 | Foundations | merged (PR #1) | Schema review of `slots` + EXCLUDE, explain-back (review) |
| 2 | Booking | merged (PR #2) | `confirm.ts`, the confirm transaction (C) |
| 3 | Patient app + search + 30-minute visits | merged (PR #3) | Search query builder (C) |
| 4 | Events | in review | Waitlist matcher: pick next + offer (C) |
| 5 | Doctor app | planned | tbd |
| 6 | Engineering console | planned | tbd |
| 7 | Demo kit | planned | tbd |

### 1. Foundations (done)
Docker Compose (Postgres, Redis, Redpanda + Console, OpenSearch), numbered SQL schema with the
`tstzrange` + EXCLUDE double-booking guard, seed (5,000 Bengaluru doctors, 300 patients), slot materializer,
`/health`, `/doctors`, a Next.js placeholder with a health panel, vitest + CI, docs.

### 2. Booking (done)
Holds with a 5-minute TTL, confirm, cancel, idempotency keys, transactional outbox + relay to Redpanda,
hold sweeper, a minimal booking UI, race demo.

### 3. Patient app + search + 30-minute visits
- **Search:** an OpenSearch read model fed by a Kafka consumer (Redpanda), a search API and a search page.
- **Patient screens:** search results, slot grid with hold countdown, My appointments.
- **30-minute visits:** a single booking covering two consecutive 15-minute slots, atomically.

### 4. Events
Live slot updates in the browser, notifier inbox, waitlist auto-offer on cancel, reminders.

### 5. Doctor app
Week view, working hours, time off, utilization numbers.

### 6. Engineering console
Race button, stop/start services, live event stream, k6 load test with a rolling restart.

### 7. Demo kit
A public link through Cloudflare Tunnel, a demo script, and an interview pack: architecture diagram, capacity
estimates, trade-offs.

## Backlog (not yet scheduled)

- **Reviews + fair rating** (added 2026-10-29 at Akshay's request; phase to be decided). A reviews table that only
  accepts a review for a completed appointment (one per appointment). `doctors.rating_avg` / `rating_count` are
  updated in the same transaction, with an outbox event `doctor.rating_changed` that the search indexer already
  handles (it re-reads the doctor). Ranking uses a Bayesian average, `(C·m + Σstars) / (C + n)`, so a 5.0 from
  2 reviews doesn't beat a 4.7 from 800, and new doctors start at the global mean.

## Changes vs plan

Newest first. Each entry: what changed from the approved plan, why, and whether Akshay approved it **before**
(asked) or **after** (reported) the change.

### Phase 4 (this PR)
- **Added at Akshay's request (asked, approved 2026-10-29):** closed-tab leases (2-minute lease renewed by
  heartbeats under a 5-minute deadline; `POST /holds/:id/heartbeat`, `GET /patients/:id/holds`, `leaseSeconds` on
  `POST /holds`) and per-patient overlap (schema 0011: EXCLUDE on held slots by patient, `appointments.during` +
  EXCLUDE by patient, max 3 live holds). ADR 0007.
- **Phase 1 test fixture** (`exclusion-constraint.test.ts` books every slot for ONE patient, which the new
  per-patient rule now correctly rejects): each booking now gets its own patient. Asked; approved.
- **Phase 3 test fixture** (`search.test.ts`, "an appointment event updates the read model") booked with an
  arbitrary existing patient (`SELECT id FROM patients LIMIT 1`). In CI's file order that patient already had a
  confirmed appointment at the same time, so the per-patient rule refused it and CI failed (68/69). Each booking
  now gets its own patient (commit 57487b6, no assertion changes). Done at Akshay's request ("fix it").
- **Waitlist doctor names:** option (b) chosen (the page fetches each doctor). Asked.
- **Built before asking (found by the plan-vs-build check; Akshay approved all four after the fact):**
  1. `idempotency.ts` (not in the "existing files touched" list) gained a shared `sendIdempotent` route helper, so
     the new waitlist and notification routes reuse the Idempotency-Key wrapper that lived inside
     `routes/booking.ts`.
  2. Leaving the waitlist while an offer is open also releases that offer's hold (so the slot moves on at once).
  3. The matcher offers a slot on ANY `hold.released` / `hold.expired`, not only those of waitlist offers (any
     lapsed hold is a freed slot).
  4. The matcher lives at `workers/src/waitlist/matcher.ts` (plus `booking-api-client.ts`), not
     `workers/src/waitlist-matcher.ts`. Other new helper files: `booking/hold-events.ts`, `waitlist.ts`,
     `notifications.ts`, `live/hub.ts`, `workers/src/{events,notify}.ts`.
- *Fixed during build (inside planned files):* the SSE stream announced `: connected` before its Redis
  subscription was active (a lost-message race); it now subscribes first and cleans up if the browser leaves
  mid-subscribe.

### Phase 3 (PR #3)
- **30-minute storage: Option 1 ("merge row")**, chosen by Akshay from two options before coding. Asked.
- **`/search` takes `lat`, `lng`, `radiusKm`, not `near=<area>`.** The plan listed both forms; only the point
  form was built, and the search page turns the chosen area into its centre point. Reported after; approved.
- **Added `GET /search/facets`** (specialties, languages, areas with centre points, from Postgres) for the search
  page's filters. Not named in the plan. Reported after; approved.
- **Hold responses now include `start` and `end`**, so the UI can show a 30-minute hold's span. Reported after; approved.
- **The indexer builds the index on start-up if the alias is missing** (self-healing first run). Reported after; approved.
- The four "reported after" items above are small additions inside the approved scope, but under the new rule
  they should have been asked first. Akshay approved all four. The fix agreed for future phases: a strict
  definition of "deviation", stop-and-ask, and a check of the built changes against the plan before every report.
- **Ranking uses `log2p` (log(2 + rating)) instead of `log1p`**, so an unrated doctor (rating 0) isn't scored 0 and
  buried. Found while explaining the query to Akshay. Asked.
- *Fixed during live verification (not scope changes):* free-text search now matches by prefix OR typo
  (`bool_prefix` + fuzzy), so search-as-you-type works ("cardio" found 0, now 332). The search-box placeholder no
  longer suggests "skin", because there are no synonyms.

### Phase 2 (PR #2)
- **Scope source:** the planning brief said only "booking endpoints". Claude wrote the Phase 2 scope and Akshay
  approved it. Roadmap phases 3–7 were not defined until 2026-10-28 (this file).
- **Schema 0008 `slots.hold_patient_id` added**, not in the plan. Confirm must book for the patient who placed
  the hold. Reported after. It forced a one-line fix to the Phase 1 exclusion-test fixture, which was asked before.
- **Hold sweeper moved from workers into booking-api.** The plan said workers, but that would break "only the
  booking API writes slots". Reported after.
- **Idempotency of concurrent duplicates:** the plan said "409 in progress". Built as "the second request waits on
  the first one's key row and replays its answer". Reported after.
- **Extra read endpoints** `GET /doctors/:id`, `/patients`, `/appointments/:id`, needed by the UI. Reported after.
- **Race demo connection pool capped at 40** after the naive mode hit Postgres's 100-connection limit. Reported after.
- **Akshay's piece mode changed from A to C** at Akshay's request: Claude wrote `confirm.ts`, Akshay answered the
  three review questions. Asked.
- **Docker infra restarted by Claude** after finding the containers removed. Reported after; should have been asked.

### Phase 1 (PR #1)
- **npm workspaces instead of pnpm** (pnpm not installed). Asked.
- **OpenSearch Dashboards skipped** to save RAM. Part of the approved plan.
- **Schema applied by Akshay by hand**, because his personal Claude Code hook blocks commands containing
  "migrate". Asked.
- **Tests use a throwaway `scheduler_test` database** created by the test setup. Asked.
