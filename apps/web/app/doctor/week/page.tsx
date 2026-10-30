'use client';

import { useCallback, useEffect, useState } from 'react';
import type { WeekView } from '@ds/shared';
import { api, ApiFailure, API_URL } from '../../api';
import { LiveBadge, useLiveUpdates } from '../../live';
import { useDoctor } from '../doctor-context';

/** Monday of the week containing `d`, as YYYY-MM-DD (dates as plain calendar days). */
function mondayOf(d: Date) {
  const day = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}
const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });

export default function WeekPage() {
  const { doctor } = useDoctor();
  const [monday, setMonday] = useState(() => mondayOf(new Date()));
  const [week, setWeek] = useState<WeekView | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!doctor) return;
    setWeek(await api<WeekView>(`/doctors/${doctor.id}/week?start=${monday}`));
  }, [doctor, monday]);

  useEffect(() => {
    load().catch((e) => setMessage((e as Error).message));
  }, [load]);

  // Live: any hold, booking, cancellation or schedule change for this doctor refreshes the week (push, or a 1-second
  // poll when a proxy blocks the stream; see live.tsx).
  const liveMode = useLiveUpdates(doctor ? `${API_URL}/doctors/${doctor.id}/slots/stream` : null, 'slots-changed', () => {
    load().catch(() => {});
  });

  const outcome = async (id: string, what: 'complete' | 'no-show') => {
    setMessage(null);
    try {
      await api(`/appointments/${id}/${what}`, { method: 'POST', idempotencyKey: crypto.randomUUID() });
    } catch (e) {
      setMessage(e instanceof ApiFailure ? e.body.message : (e as Error).message);
    }
    await load();
  };

  const now = Date.now();
  return (
    <section>
      <div className="controls">
        <button onClick={() => setMonday(shift(monday, -7))}>← Previous</button>
        <strong>Week of {dayLabel(monday)}</strong>
        <button onClick={() => setMonday(shift(monday, 7))}>Next →</button>
        <button onClick={() => setMonday(mondayOf(new Date()))}>This week</button>
      </div>
      {message && <p className="error">{message}</p>}
      <div className="week">
        {week?.days.map((day) => (
          <div key={day.date} className="day">
            <div className="dayhead">{dayLabel(day.date)}</div>
            {day.slots.length === 0 && <div className="muted small">Off</div>}
            {day.slots.map((s) => {
              const a = s.appointment;
              if (a && !a.startsHere) return null; // second half of a 30-minute visit: drawn as one block
              const past = new Date(s.start).getTime() <= now;
              return (
                <div
                  key={s.id}
                  className={`cell ${s.status}${a?.minutes === 30 ? ' tall' : ''}${s.outsideHours ? ' flagged' : ''}${past ? ' past' : ''}`}
                  title={s.blockedReason ? `blocked: ${s.blockedReason}` : s.status}
                >
                  <span className="time">{s.localTime}</span>
                  {a ? (
                    <span>
                      {a.patientName} · {a.minutes}m{a.status !== 'confirmed' && ` · ${a.status.replace('_', '-')}`}
                      {s.outsideHours && <span className="badge down">outside hours</span>}
                      {a.status === 'confirmed' && past && (
                        <span className="actions">
                          <button onClick={() => outcome(a.id, 'complete')}>Done</button>
                          <button onClick={() => outcome(a.id, 'no-show')}>No-show</button>
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="muted">{s.status === 'blocked' ? (s.blockedReason === 'time_off' ? 'time off' : 'closed') : s.status}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p className="muted small">
        Times in {week?.tz}. <LiveBadge mode={liveMode} />. A kept booking outside your new hours is flagged; record Done / No-show once a visit has started.
      </p>
    </section>
  );
}
