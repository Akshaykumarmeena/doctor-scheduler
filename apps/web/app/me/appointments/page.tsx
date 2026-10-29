'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { Appointment, PatientAppointment } from '@ds/shared';
import { api, ApiFailure } from '../../api';
import { usePatient } from '../../patient';

export default function MyAppointmentsPage() {
  const { patient } = usePatient();
  const [items, setItems] = useState<PatientAppointment[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patient) return;
    const r = await api<{ appointments: PatientAppointment[] }>(`/patients/${patient.id}/appointments`);
    setItems(r.appointments);
  }, [patient]);

  useEffect(() => {
    load().catch((e) => setMessage((e as Error).message));
  }, [load]);

  const cancel = async (id: string) => {
    setMessage(null);
    try {
      await api<Appointment>(`/appointments/${id}/cancel`, { method: 'POST', idempotencyKey: crypto.randomUUID() });
    } catch (e) {
      setMessage(e instanceof ApiFailure ? e.body.message : (e as Error).message);
    }
    await load();
  };

  const now = Date.now();
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
