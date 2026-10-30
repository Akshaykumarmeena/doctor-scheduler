# Demo script

A 10-minute walkthrough of doctor-scheduler, with what to **click** and what to **say**. A 2-minute version and a
"if something breaks" section are at the end.

## Before the interview (5 minutes, once)

```
npm run dev:infra        # Docker: Postgres, Redis, Redpanda, OpenSearch (wait for healthy)
npm run demo:reset       # known state: 2 bookings for Dr. Shreya Kulkarni on the next weekday
npm run demo             # cluster + production web build + public link (Ctrl+C closes the link)
```

- `npm run demo` prints a `https://….trycloudflare.com` link. Share it only if the interviewer wants to click
  around themselves. On their side the badge under the slot grid reads "↻ updating every 1 s": the free tunnel blocks
  streaming, so the page fell back to polling every second (updates arrive in about a second). On your screen it
  reads "● live" (pushed instantly). That difference is itself a talking point (see questions.md).
- Open three tabs on **your** machine: http://localhost:3000/search · http://localhost:3000/doctor/week ·
  http://localhost:3000/console
- Top right: patient = Aarav Kumar.

## The 10-minute version

| # | Click | Say |
| --- | --- | --- |
| 1 | **Search**: type `cardio`, pick Language = Kannada, "Free on" a weekday | "Search is an OpenSearch read model fed by Kafka. It can lag by a second, so booking never trusts it; it re-checks in Postgres." |
| 2 | Open a doctor → **30 min** → click a time → countdown → **Confirm** | "A hold is data with a TTL, not a lock. Thirty minutes is one row over two fifteen-minute slots; an exclusion constraint makes overlaps impossible in the database itself." |
| 3 | **Console → Race**: "Through the API", then "Naive" | "100 patients, one slot. Through the API: exactly one winner, 99 conflicts, because the check is inside the UPDATE. The naive read-then-write version tells 60 people 'yes'. That's the bug this design exists to prevent." |
| 4 | Two windows: patient grid for Dr. Kulkarni + **Doctor app → Time off** over a booked time → Check → Confirm | "Time off is one transaction: lock the slots, release holds, cancel bookings, block slots, write events. The patient's grid closes live and their inbox says the doctor is unavailable, via the outbox, Kafka and Redis to SSE." |
| 5 | **Console → Stop redis** → book something → **Start redis** | "Redis only powers live updates. Booking doesn't depend on it, so it keeps working. Failure isolation." |
| 6 | **Console → Stop opensearch** → watch search-indexer's lag rise → **Start** → lag drains | "Each consumer group has its own offset. The indexer falls behind and catches up; notifications and the waitlist never noticed." |
| 7 | **Console → Load test**: 20 VUs, 40 s, ✓ rolling restart → Run | "This is a deploy under load: both API instances restart mid-run. Graceful drain plus nginx retries gives zero failed requests. Retrying a POST is only safe because every write carries an idempotency key." |
| 8 | **Guarantees panel** | "These are live SQL checks: double bookings, a patient in two places, holds inside time off. They're zero after everything we just did." |
| 9 | (Optional) **Doctor app → Numbers** | "Utilization, cancellation and no-show rates, each with a written denominator." |

Close with: "Correctness lives in Postgres constraints; everything downstream is an idempotent consumer of an
outbox-fed event log; and I can prove it under load and during a deploy."

## With the interviewer clicking too (public link)

1. Paste the link. They open a doctor; you open the same doctor and day on your screen.
2. They hold or book a time → it greys out on your screen at once (push).
3. You book a time → it greys out on theirs within about a second (their page polls).
4. You add time off over their booking (Doctor app) → their grid closes and their Inbox says "Doctor unavailable…".
5. Say: "Your link goes through a free tunnel that blocks streaming. Your page noticed the missing heartbeat and
   switched to polling every second by itself. Same data, same guarantees."
6. Ctrl+C `npm run demo` at the end: the link is dead.

## The 2-minute version

1 (search) → 3 (race) → 7 (load test with rolling restart) → 8 (guarantees). One sentence each.

## If something breaks live

| Symptom | Do |
| --- | --- |
| Console says "ops service isn't running" | You started `npm run dev`, not `demo`/`dev:cluster`. Stop it, run `npm run dev:cluster`. |
| Search shows "unavailable" | OpenSearch is stopped (maybe by you in step 6). Console → Start opensearch. |
| A slot you expected is grey | Someone (maybe you) holds it; holds end after 5 min, or `npm run demo:reset`. |
| Load test stays "running" on the first run | It's pulling the k6 image (~60 MB) once. Wait. |
| Public link shows an error page | The tunnel is down: Ctrl+C `npm run demo` and start it again (you get a new URL). |
| Anything weird | `npm run demo:reset`, refresh. Say: "Let me reset to a known state," which is itself good practice. |
