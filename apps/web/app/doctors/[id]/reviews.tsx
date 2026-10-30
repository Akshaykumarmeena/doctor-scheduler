'use client';

import { useEffect, useState } from 'react';
import type { DoctorReviews } from '@ds/shared';
import { api } from '../../api';

/** The doctor's fair rating, how the stars are spread, and the latest reviews (Phase 8). */
export function Reviews({ doctorId }: { doctorId: string }) {
  const [data, setData] = useState<DoctorReviews | null>(null);

  useEffect(() => {
    api<DoctorReviews>(`/doctors/${doctorId}/reviews?limit=5`).then(setData).catch(() => setData(null));
  }, [doctorId]);

  if (!data) return null;
  const most = Math.max(1, ...Object.values(data.distribution));
  return (
    <section className="panel">
      <h2>Reviews</h2>
      {data.count === 0 ? (
        <p className="muted">No reviews yet. ★ {data.fair} is the starting rating; real reviews move it.</p>
      ) : (
        <>
          <p>
            <strong>★ {data.fair}</strong> <span className="muted">fair rating from {data.count} review{data.count === 1 ? '' : 's'}</span>
          </p>
          <ul className="list">
            {(['5', '4', '3', '2', '1'] as const).map((s) => (
              <li key={s} className="small">
                {s}★{' '}
                <span style={{ display: 'inline-block', width: `${(data.distribution[s] / most) * 60}%`, height: 8, background: 'var(--ok)', borderRadius: 4 }} />{' '}
                {data.distribution[s]}
              </li>
            ))}
          </ul>
          <ul className="list">
            {data.reviews.map((r, i) => (
              <li key={i}>
                <strong>{'★'.repeat(r.stars)}</strong> <span className="muted small">{r.patientFirstName} · {new Date(r.createdAt).toLocaleDateString('en-IN')}</span>
                {r.comment && <div>{r.comment}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small">Fair rating = (20 × starting rating + sum of stars) / (20 + reviews): a few reviews can't swing it.</p>
    </section>
  );
}
