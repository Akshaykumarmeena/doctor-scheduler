'use client';

import { useEffect, useState } from 'react';
import type { WorkingHours } from '@ds/shared';
import { api, ApiFailure } from '../../api';
import { useDoctor } from '../doctor-context';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIMES = Array.from({ length: 4 * 24 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);

interface Result {
  addedSlots: number;
  blockedSlots: number;
  reopenedSlots: number;
  keptBookingsOutsideHours: number;
}

export default function HoursPage() {
  const { doctor } = useDoctor();
  const [hours, setHours] = useState<WorkingHours[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!doctor) return;
    setResult(null);
    api<{ templates: WorkingHours[] }>(`/doctors/${doctor.id}/templates`).then((r) => setHours(r.templates), (e) => setMessage((e as Error).message));
  }, [doctor]);

  const update = (i: number, patch: Partial<WorkingHours>) => setHours((h) => h.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const save = async () => {
    setMessage(null);
    try {
      const r = await api<Result & { hours: WorkingHours[] }>(`/doctors/${doctor!.id}/templates`, {
        method: 'PUT',
        body: { templates: hours.map(({ weekday, startLocal, endLocal }) => ({ weekday, startLocal, endLocal })) },
        idempotencyKey: crypto.randomUUID(),
      });
      setHours(r.hours);
      setResult(r);
    } catch (e) {
      setMessage(e instanceof ApiFailure ? e.body.message : (e as Error).message);
    }
  };

  return (
    <section className="panel">
      <h2>Working hours</h2>
      <p className="muted small">Changes apply from tomorrow. Open slots outside the new hours close; bookings already made are kept and flagged.</p>
      {hours.map((h, i) => (
        <div key={i} className="controls">
          <select value={h.weekday} onChange={(e) => update(i, { weekday: Number(e.target.value) })} aria-label="Day">
            {DAYS.map((d, k) => <option key={d} value={k + 1}>{d}</option>)}
          </select>
          <select value={h.startLocal} onChange={(e) => update(i, { startLocal: e.target.value })} aria-label="From">
            {TIMES.map((t) => <option key={t}>{t}</option>)}
          </select>
          to
          <select value={h.endLocal} onChange={(e) => update(i, { endLocal: e.target.value })} aria-label="To">
            {TIMES.map((t) => <option key={t}>{t}</option>)}
          </select>
          <button onClick={() => setHours((x) => x.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <div className="controls">
        <button onClick={() => setHours((x) => [...x, { weekday: 1, startLocal: '09:00', endLocal: '13:00' }])}>Add hours</button>
        <button className="primary" onClick={save} disabled={!doctor}>Save from tomorrow</button>
      </div>
      {result && (
        <p className="small">
          Saved. {result.addedSlots} new slots opened, {result.blockedSlots} closed, {result.reopenedSlots} reopened.
          {result.keptBookingsOutsideHours > 0 && ` ${result.keptBookingsOutsideHours} existing booking(s) are outside the new hours and were kept (flagged in Week).`}
        </p>
      )}
      {message && <p className="error">{message}</p>}
    </section>
  );
}
