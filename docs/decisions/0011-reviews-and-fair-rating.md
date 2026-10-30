# 0011 – Reviews and a fair (Bayesian) rating

Status: accepted (Phase 8, 2026-10-30; decisions by Akshay)

## Context

Search ranks doctors by rating. A plain average is unfair in both directions: a newcomer with two 5-star reviews
(5.0) would outrank a doctor with 800 reviews averaging 4.7, and one bad first review would bury a new doctor.
Reviews must also be trustworthy: only real, finished visits count.

## Decisions

1. **One review per completed visit, by that visit's patient, no edits.** `reviews.appointment_id` is UNIQUE;
   booking-api locks the appointment (`FOR UPDATE`), checks the patient (403 `not_your_appointment`) and the status
   (409 `appointment_not_completed`), then `INSERT … ON CONFLICT DO NOTHING` (409 `already_reviewed`). There is no
   login yet, so the request names the patient (`patientId`, as for holds and the waitlist); a real login replaces
   it later. Like every write, it takes an Idempotency-Key.
2. **Fair rating = (C · prior + Σstars) / (C + n), C = 20.** The prior is the doctor's rating before their first
   real review (the seeded one, captured in `doctors.rating_prior` on that review), or the platform mean for a
   doctor with none. `doctors.rating` holds the fair value (1 decimal), so search and every page use it unchanged.
   2 × 5★ → 4.1 (from a 4.0 prior); 800 reviews averaging 4.7 → 4.7.
3. **Recomputed in the same transaction as the review**, in ONE `UPDATE` on the doctor's row. The row lock
   serializes concurrent reviews of a doctor, and the right-hand sides read the old row, so each review is added
   exactly once (tested with 10 concurrent reviews). Storing `rating_count` and `rating_sum` makes the update O(1):
   no re-scan of all reviews.
4. **Event `doctor.rating_changed`** in the outbox, same transaction. The search-indexer already rebuilds a doctor's
   document from Postgres for any non-hold event, so search follows within about a second. The notifier and the
   waitlist matcher ignore it. The index gains `rating_count` (for "★ 4.6 (128)"); the mapping is strict, so this
   needed a **zero-downtime reindex** (new index + atomic alias swap, ADR 0003).

## Consequences

- Deploy order for the mapping change: migrate → `npm run search:reindex` → restart workers. (Workers running new
  code against the old index would be rejected by the strict mapping; the search API tolerates the old index by
  treating a missing count as 0.)
- The platform mean is computed with one `avg()` over doctors, only for a doctor with no rating at all (never in
  the demo data). At scale it would be a cached number refreshed periodically.
- C is a product knob: higher means "trust reviews less until there are many". 20 ≈ "a doctor's own reviews
  outweigh the prior after 20 reviews".
- Not built: review moderation, edits/deletes, doctor replies, weighting recent reviews more, fraud detection.
- At scale (sharded by doctor): reviews carry `doctor_id`, so the review, the doctor row and the outbox event stay on
  one shard. One transaction, unchanged.
