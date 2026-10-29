'use client';

import { useEffect, useState } from 'react';
import type { DoctorStats } from '@ds/shared';
import { api } from '../../api';
import { useDoctor } from '../doctor-context';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const RANGES = {
  'Last 7 days': () => [iso(new Date(Date.now() - 6 * 86_400_000)), iso(new Date())],
  'Next 14 days': () => [iso(new Date()), iso(new Date(Date.now() + 13 * 86_400_000))],
} as const;
type RangeName = keyof typeof RANGES;

export default function StatsPage() {
  const { doctor } = useDoctor();
  const [range, setRange] = useState<RangeName>('Next 14 days');
  const [stats, setStats] = useState<DoctorStats | null>(null);

  useEffect(() => {
    if (!doctor) return;
    const [from, to] = RANGES[range]();
    api<DoctorStats>(`/doctors/${doctor.id}/stats?from=${from}&to=${to}`).then(setStats, () => setStats(null));
  }, [doctor, range]);

  const max = Math.max(1, ...(stats?.byDay.map((d) => d.offeredMinutes) ?? [1]));
  const tiles: [string, string][] = stats
    ? [
        ['Utilization', `${stats.utilizationPct}%`],
        ['Booked / offered', `${Math.round(stats.bookedMinutes / 60)} h / ${Math.round(stats.offeredMinutes / 60)} h`],
        ['Appointments', String(stats.appointments)],
        ['Cancellation rate', `${stats.cancellationRatePct}% (${stats.cancellations})`],
        ['No-show rate', `${stats.noShowRatePct}% (${stats.noShows})`],
        ['Avg lead time', stats.avgLeadTimeHours === null ? '–' : `${stats.avgLeadTimeHours} h`],
        ['Waitlist waiting', String(stats.waitlistWaiting)],
      ]
    : [];

  return (
    <section className="panel">
      <div className="controls">
        <h2>Numbers</h2>
        <select value={range} onChange={(e) => setRange(e.target.value as RangeName)} aria-label="Range">
          {Object.keys(RANGES).map((r) => <option key={r}>{r}</option>)}
        </select>
      </div>
      <div className="tiles">
        {tiles.map(([label, value]) => (
          <div key={label} className="tile">
            <div className="muted small">{label}</div>
            <div className="value">{value}</div>
          </div>
        ))}
      </div>
      <h2>Booked vs offered, per day</h2>
      <div className="bars" role="img" aria-label="Booked minutes against offered minutes per day">
        {stats?.byDay.map((d) => (
          <div key={d.date} className="bar" title={`${d.date}: ${d.bookedMinutes} of ${d.offeredMinutes} min booked`}>
            <div className="offered" style={{ height: `${(100 * d.offeredMinutes) / max}%` }}>
              <div className="booked" style={{ height: `${d.offeredMinutes ? (100 * d.bookedMinutes) / d.offeredMinutes : 0}%` }} />
            </div>
            <div className="muted small">{d.date.slice(8)}</div>
          </div>
        ))}
      </div>
      <p className="muted small">
        Offered = slots not closed or on time off. Booked = confirmed, completed and no-show visits (a 30-minute visit counts 30).
        No-show rate counts only visits with a recorded outcome.
      </p>
    </section>
  );
}
