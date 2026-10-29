'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AffectedAppointment, TimeOff, TimeOffKind } from '@ds/shared';
import { api, ApiFailure } from '../../api';
import { useDoctor } from '../doctor-context';

type Listed = TimeOff & { affectedAppointments: number };

export default function TimeOffPage() {
  const { doctor } = useDoctor();
  const [list, setList] = useState<Listed[]>([]);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [kind, setKind] = useState<TimeOffKind>('leave');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<AffectedAppointment[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-IN', { timeZone: doctor?.tz ?? 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

  const load = useCallback(async () => {
    if (!doctor) return;
    setList((await api<{ timeOff: Listed[] }>(`/doctors/${doctor.id}/time-off`)).timeOff);
  }, [doctor]);
  useEffect(() => {
    load().catch((e) => setMessage((e as Error).message));
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof ApiFailure ? e.body.message : (e as Error).message);
    }
  };

  // Step 1: show exactly which bookings would be cancelled (decision 2a: preview, then confirm).
  const check = () =>
    run(async () => {
      const r = await api<{ affectedAppointments: AffectedAppointment[] }>(
        `/doctors/${doctor!.id}/time-off/preview?start=${start}&end=${end}`,
      );
      setPreview(r.affectedAppointments);
    });
  // Step 2: confirm.
  const confirm = () =>
    run(async () => {
      const r = await api<{ cancelledAppointments: AffectedAppointment[]; blockedSlots: number }>(`/doctors/${doctor!.id}/time-off`, {
        method: 'POST',
        body: { start, end, kind, ...(reason ? { reason } : {}) },
        idempotencyKey: crypto.randomUUID(),
      });
      setPreview(null);
      setMessage(`Time off added: ${r.blockedSlots} slots closed, ${r.cancelledAppointments.length} booking(s) cancelled and the patients notified.`);
      await load();
    });
  const remove = (id: string) =>
    run(async () => {
      await api(`/doctors/${doctor!.id}/time-off/${id}`, { method: 'DELETE', idempotencyKey: crypto.randomUUID() });
      await load();
    });

  return (
    <section className="panel">
      <h2>Time off</h2>
      <div className="controls">
        <label>From <input type="datetime-local" step={900} value={start} onChange={(e) => (setStart(e.target.value), setPreview(null))} /></label>
        <label>To <input type="datetime-local" step={900} value={end} onChange={(e) => (setEnd(e.target.value), setPreview(null))} /></label>
        <select value={kind} onChange={(e) => setKind(e.target.value as TimeOffKind)} aria-label="Kind">
          <option value="leave">Leave</option>
          <option value="holiday">Holiday</option>
          <option value="blocked">Blocked</option>
        </select>
        <input placeholder="Reason (shown to patients)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button onClick={check} disabled={!doctor || !start || !end}>Check</button>
      </div>
      {preview && (
        <div className="panel offer">
          {preview.length === 0 ? (
            <p>No bookings in that time.</p>
          ) : (
            <>
              <p><strong>{preview.length} booking(s) will be cancelled</strong> and the patients notified:</p>
              <ul className="list">{preview.map((a) => <li key={a.id}>{fmt(a.start)} · {a.patientName}</li>)}</ul>
            </>
          )}
          <button className="primary" onClick={confirm}>Confirm time off</button>
        </div>
      )}
      {message && <p className="small">{message}</p>}

      <h2>Upcoming</h2>
      {list.length === 0 && <p className="muted">None.</p>}
      {list.map((t) => (
        <div key={t.id} className="result">
          <div>
            {fmt(t.start)} → {fmt(t.end)} · {t.kind}
            {t.reason && ` · ${t.reason}`}
            {t.affectedAppointments > 0 && <span className="muted"> · {t.affectedAppointments} booking(s) cancelled</span>}
          </div>
          <button onClick={() => remove(t.id)}>Remove</button>
        </div>
      ))}
    </section>
  );
}
