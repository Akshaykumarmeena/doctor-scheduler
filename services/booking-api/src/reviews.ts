// Reviews and the fair rating (Phase 8, ADR 0011).
//
// A plain average lies when there are few reviews: two 5-star reviews would beat 800 reviews averaging 4.7.
// The fair rating is a Bayesian average: start every doctor with C = 20 "imaginary" reviews at their prior,
// and let real reviews pull them away from it:
//
//   fair = (C * prior + sum of stars) / (C + number of reviews)
//
// Few reviews -> close to the prior; many reviews -> close to the real average.
import type { DoctorReviews, ReviewCreated } from '@ds/shared';
import type { Pool } from './db.js';
import { conflict, forbidden, notFound } from './errors.js';
import type { Tx } from './idempotency.js';

/** How many imaginary reviews the prior is worth. */
export const PRIOR_WEIGHT = 20;

export async function createReview(
  tx: Tx,
  appointmentId: string,
  input: { patientId: string; stars: number; comment?: string },
): Promise<ReviewCreated> {
  // Lock the appointment: its status can't change under us, and two reviews of it queue up here.
  const appt = await tx.query<{ doctor_id: string; patient_id: string; status: string }>(
    'SELECT doctor_id, patient_id, status FROM appointments WHERE id = $1 FOR UPDATE',
    [appointmentId],
  );
  const a = appt.rows[0];
  if (!a) throw notFound('appointment_not_found', 'No such appointment');
  if (a.patient_id !== input.patientId) throw forbidden('not_your_appointment', 'Only the patient of this visit can review it');
  if (a.status !== 'completed') throw conflict('appointment_not_completed', 'Only a completed visit can be reviewed');

  const comment = input.comment?.trim() || null;
  const inserted = await tx.query<{ id: string; stars: number; comment: string | null; createdAt: string }>(
    `INSERT INTO reviews (appointment_id, doctor_id, patient_id, stars, comment)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (appointment_id) DO NOTHING
     RETURNING id, stars, comment, created_at AS "createdAt"`,
    [appointmentId, a.doctor_id, a.patient_id, input.stars, comment],
  );
  const review = inserted.rows[0];
  if (!review) throw conflict('already_reviewed', 'This visit has already been reviewed');

  // Recompute in ONE statement on the doctor's row: the row lock serializes concurrent reviews of a doctor, and
  // the right-hand sides read the row as it was, so "+ 1" / "+ stars" are applied exactly once each.
  // The prior is captured on the first review: the doctor's rating so far, or the platform mean if they had none.
  const doctor = await tx.query<{ fair: number; count: number }>(
    `UPDATE doctors d
        SET rating_prior = p.prior,
            rating_count = d.rating_count + 1,
            rating_sum   = d.rating_sum + $2,
            rating       = round(($3 * p.prior + d.rating_sum + $2) / ($3 + d.rating_count + 1), 1)
       FROM (SELECT coalesce(rating_prior, nullif(rating, 0),
                             (SELECT round(avg(rating), 1) FROM doctors WHERE rating > 0), 0) AS prior
               FROM doctors WHERE id = $1) p
      WHERE d.id = $1
      RETURNING d.rating::float AS fair, d.rating_count AS count`,
    [a.doctor_id, input.stars, PRIOR_WEIGHT],
  );
  const doctorRating = doctor.rows[0];

  // Search ranks by rating: the search-indexer rebuilds this doctor's document when it sees the event.
  await tx.query(
    `INSERT INTO outbox (doctor_id, aggregate_id, event_type, payload)
     VALUES ($1, $1, 'doctor.rating_changed', $2)`,
    [a.doctor_id, JSON.stringify({ doctorId: a.doctor_id, reviewId: review.id, rating: doctorRating.fair, ratingCount: doctorRating.count })],
  );
  return { ...review, doctorRating };
}

/** A doctor's fair rating, the star distribution and the latest reviews (first names only). */
export async function reviewsForDoctor(pool: Pool, doctorId: string, limit: number): Promise<DoctorReviews> {
  const { rows } = await pool.query<DoctorReviews>(
    `SELECT d.rating::float AS fair, d.rating_count AS count,
            (SELECT json_build_object(
                      '1', count(*) FILTER (WHERE stars = 1), '2', count(*) FILTER (WHERE stars = 2),
                      '3', count(*) FILTER (WHERE stars = 3), '4', count(*) FILTER (WHERE stars = 4),
                      '5', count(*) FILTER (WHERE stars = 5))
               FROM reviews WHERE doctor_id = d.id) AS distribution,
            coalesce((SELECT json_agg(r ORDER BY r."createdAt" DESC) FROM (
               SELECT rv.stars, rv.comment, rv.created_at AS "createdAt", split_part(p.name, ' ', 1) AS "patientFirstName"
                 FROM reviews rv JOIN patients p ON p.id = rv.patient_id
                WHERE rv.doctor_id = d.id
                ORDER BY rv.created_at DESC
                LIMIT $2) r), '[]') AS reviews
       FROM doctors d WHERE d.id = $1`,
    [doctorId, limit],
  );
  if (!rows[0]) throw notFound('doctor_not_found', 'No such doctor');
  return rows[0];
}
