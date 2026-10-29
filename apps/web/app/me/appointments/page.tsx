'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { Appointment, Doctor, PatientAppointment, WaitlistEntry } from '@ds/shared';
import { api, ApiFailure } from '../../api';
import { usePatient } from '../../patient';

export default function MyAppointmentsPage() {
  const { patient, inboxVersion } = usePatient();
  const [items, setItems] = useState<PatientAppointment[] | null>(null);
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [doctors, setDoctors] = useState<Record<string, Doctor>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!patient) return;
    const [a, w] = await Promise.all([
      api<{ appointments: PatientAppointment[] }>(`/patients/${patient.id}/appointments`),
      api<{ entries: WaitlistEntry[] }>(`/patients/${patient.id}/waitlist`),
    ]);
    setItems(a.appointments);
    setWaitlist(w.entries);
    // Doctor names for waitlist entries (the waitlist response carries only doctorId).
    const missing = [...new Set(w.entries.map((e) => e.doctorId))];
    const fetched = await Promise.all(missing.map((id) => api<Doctor>(`/doctors/${id}`)));
    setDoctors(Object.fromEntries(fetched.map((d) => [d.id, d])));
  }, [patient]);

  // Reload on every live notification (an offer arriving, expiring, ...).
  useEffect(() => {
    load().catch((e) => setMessage((e as Error).message));
  }, [load, inboxVersion]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof ApiFailure ? e.body.message : (e as Error).message);
    }
    await load();
  };
  const key = () => crypto.randomUUID();
  const accept = (holdId: string) =>
    run(() => api('/appointments', { method: 'POST', body: { holdId, visitType: 'in_person' }, idempotencyKey: key() }));
  const decline = (holdId: string) => run(() => api(`/holds/${holdId}`, { method: 'DELETE', idempotencyKey: key() }));
  const leave = (id: string) => run(() => api(`/waitlist/${id}`, { method: 'DELETE', idempotencyKey: key() }));

  const cancel = (id: string) => run(() => api<Appointment>(`/appointments/${id}/cancel`, { method: 'POST', idempotencyKey: key() }));

  const upcoming = items?.filter((a) => new Date(a.start).getTime() >= now) ?? [];
  const past = items?.filter((a) => new Date(a.start).getTime() < now) ?? [];

  return (
    <main>
      <h1>My appointments</h1>
      <p className="lede">{patient ? `Signed in as ${patient.name} (demo: switch patient at the top right).` : 'Loading…'}</p>
      {message && <p className="error">{message}</p>}
      {items && items.length === 0 && (
        <p className="muted">No appointments yet. <Link href="/search">Find a doctor →</Link></p>
      )}
      {waitlist.some((w) => w.status === 'offered' || w.status === 'waiting') && <h2>Waitlist</h2>}
      {waitlist
        .filter((w) => w.status === 'offered' || w.status === 'waiting')
        .map((w) => {
          const d = doctors[w.doctorId];
          const left = w.offer ? Math.max(0, Math.round((new Date(w.offer.expiresAt).getTime() - now) / 1000)) : 0;
          const fmt = new Intl.DateTimeFormat('en-IN', { timeZone: d?.tz ?? 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          return (
            <section key={w.id} className={`panel result${w.offer ? ' offer' : ''}`}>
              <div>
                <Link href={`/doctors/${w.doctorId}?date=${w.date}`} className="name">{d?.name ?? 'Doctor'}</Link>
                <div className="muted">{d ? `${d.specialty} · ${d.clinic}, ${d.area}` : ''}</div>
                {w.offer ? (
                  <div className="small">
                    <strong>Slot offered:</strong> {fmt.format(new Date(w.offer.start))} · held for you for{' '}
                    <strong>{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</strong>
                  </div>
                ) : (
                  <div className="small">Waiting for any slot on {w.date}. You'll get a message if one frees up.</div>
                )}
              </div>
              <div className="controls">
                {w.offer && left > 0 && <button className="primary" onClick={() => accept(w.offer!.holdId)}>Accept</button>}
                {w.offer && left > 0 && <button onClick={() => decline(w.offer!.holdId)}>Decline</button>}
                {!w.offer && <button onClick={() => leave(w.id)}>Leave waitlist</button>}
              </div>
            </section>
          );
        })}
      {upcoming.length > 0 && <h2>Upcoming</h2>}
      {upcoming.map((a) => <Row key={a.id} a={a} onCancel={cancel} />)}
      {past.length > 0 && <h2>Past</h2>}
      {past.map((a) => <Row key={a.id} a={a} />)}
    </main>
  );
}

function Row({ a, onCancel }: { a: PatientAppointment; onCancel?: (id: string) => void }) {
  const fmt = new Intl.DateTimeFormat('en-IN', { timeZone: a.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const minutes = Math.round((new Date(a.end).getTime() - new Date(a.start).getTime()) / 60_000);
  return (
    <section className="panel result">
      <div>
        <Link href={`/doctors/${a.doctorId}`} className="name">{a.doctorName}</Link>
        <div className="muted">{a.specialty} · {a.clinic}, {a.area}</div>
        <div className="small">
          {fmt.format(new Date(a.start))} · {minutes} min · {a.visitType.replace('_', ' ')}{' '}
          <span className={a.status === 'confirmed' ? 'badge ok' : 'badge down'}>{a.status}</span>
        </div>
      </div>
      {onCancel && a.status === 'confirmed' && <button onClick={() => onCancel(a.id)}>Cancel</button>}
    </section>
  );
}
