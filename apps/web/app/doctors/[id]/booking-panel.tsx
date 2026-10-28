'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Appointment, Doctor, Hold, Patient, SlotView } from '@ds/shared';
import { api, ApiFailure } from '../../api';

/** The next 14 calendar dates as YYYY-MM-DD in the doctor's time zone. */
function nextDates(tz: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const label = new Intl.DateTimeFormat('en-IN', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.now() + i * 86_400_000);
    return { value: fmt.format(d), label: label.format(d) };
  });
}

function errorText(err: unknown) {
  if (err instanceof ApiFailure) return `${err.status} ${err.body.error}: ${err.body.message}`;
  return (err as Error).message;
}

export function BookingPanel({ doctorId }: { doctorId: string }) {
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientId, setPatientId] = useState('');
  const [date, setDate] = useState('');
  const [slots, setSlots] = useState<SlotView[]>([]);
  const [hold, setHold] = useState<Hold | null>(null);
  const [appointment, setAppointment] = useState<Appointment | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    api<Doctor>(`/doctors/${doctorId}`).then((d) => {
      setDoctor(d);
      setDate(nextDates(d.tz)[0].value);
    }, (e) => setMessage(errorText(e)));
    api<{ patients: Patient[] }>('/patients?limit=20').then((r) => {
      setPatients(r.patients);
      setPatientId(r.patients[0]?.id ?? '');
    }, (e) => setMessage(errorText(e)));
  }, [doctorId]);

  const loadSlots = useCallback(async () => {
    if (!date) return;
    const r = await api<{ slots: SlotView[] }>(`/doctors/${doctorId}/slots?date=${date}`);
    setSlots(r.slots);
  }, [doctorId, date]);

  useEffect(() => {
    loadSlots().catch((e) => setMessage(errorText(e)));
  }, [loadSlots]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Each user action gets its own idempotency key.
  async function act(fn: (key: string) => Promise<void>) {
    setMessage(null);
    try {
      await fn(crypto.randomUUID());
    } catch (e) {
      setMessage(errorText(e));
    }
    await loadSlots().catch(() => {});
  }

  const holdSlot = (slotId: string) =>
    act(async (key) => {
      setAppointment(null);
      setHold(await api<Hold>('/holds', { method: 'POST', body: { slotId, patientId }, idempotencyKey: key }));
    });
  const release = () =>
    act(async (key) => {
      await api(`/holds/${hold!.holdId}`, { method: 'DELETE', idempotencyKey: key });
      setHold(null);
    });
  const confirm = () =>
    act(async (key) => {
      const appt = await api<Appointment>('/appointments', { method: 'POST', body: { holdId: hold!.holdId, visitType: 'in_person' }, idempotencyKey: key });
      setAppointment(appt);
      setHold(null);
    });
  const cancel = () =>
    act(async (key) => {
      setAppointment(await api<Appointment>(`/appointments/${appointment!.id}/cancel`, { method: 'POST', idempotencyKey: key }));
    });

  if (!doctor) return <p className="muted">{message ?? 'Loading…'}</p>;
  const secondsLeft = hold ? Math.max(0, Math.round((new Date(hold.expiresAt).getTime() - now) / 1000)) : 0;
  const localTime = (iso: string) =>
    new Intl.DateTimeFormat('en-IN', { timeZone: doctor.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

  return (
    <>
      <h1>{doctor.name}</h1>
      <p className="lede">
        {doctor.specialty} · {doctor.clinic}, {doctor.area} · ★ {doctor.rating} · {doctor.languages.join(', ')}
      </p>

      <section className="panel">
        <div className="controls">
          <label>
            Patient{' '}
            <select value={patientId} onChange={(e) => setPatientId(e.target.value)}>
              {patients.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>
            Day{' '}
            <select value={date} onChange={(e) => setDate(e.target.value)}>
              {nextDates(doctor.tz).map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </label>
        </div>

        {slots.length === 0 ? (
          <p className="muted">No slots this day (weekend, leave, or not materialized).</p>
        ) : (
          <div className="slots">
            {slots.map((s) => (
              <button
                key={s.id}
                className={`slot ${s.status}${hold?.slotId === s.id ? ' mine' : ''}`}
                disabled={s.status !== 'open' || !!hold}
                onClick={() => holdSlot(s.id)}
                title={`${s.status} · ${s.start} UTC`}
              >
                {s.localTime}
              </button>
            ))}
          </div>
        )}
        <p className="muted small">Times in {doctor.tz}. Grey = held or booked by someone.</p>
      </section>

      {hold && (
        <section className="panel">
          <h2>Held for you</h2>
          <p>
            {localTime(slots.find((s) => s.id === hold.slotId)?.start ?? hold.expiresAt)} · expires in{' '}
            <strong>{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</strong>
          </p>
          <div className="controls">
            <button className="primary" onClick={confirm} disabled={secondsLeft === 0}>Confirm booking</button>
            <button onClick={release}>Release</button>
          </div>
        </section>
      )}

      {appointment && (
        <section className="panel">
          <h2>
            Appointment <span className={appointment.status === 'confirmed' ? 'badge ok' : 'badge down'}>{appointment.status}</span>
          </h2>
          <p>{localTime(appointment.start)} · {appointment.visitType.replace('_', ' ')}</p>
          <p className="muted small">id {appointment.id}</p>
          {appointment.status === 'confirmed' && <button onClick={cancel}>Cancel appointment</button>}
        </section>
      )}

      {message && <p className="error">{message}</p>}
    </>
  );
}
