'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { Appointment, Doctor, Hold, SlotView } from '@ds/shared';
import { api, ApiFailure } from '../../api';
import { usePatient } from '../../patient';

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

export function BookingPanel({ doctorId, initialDate }: { doctorId: string; initialDate?: string }) {
  const { patient } = usePatient();
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [date, setDate] = useState('');
  const [minutes, setMinutes] = useState<15 | 30>(15);
  const [slots, setSlots] = useState<SlotView[]>([]);
  const [hold, setHold] = useState<Hold | null>(null);
  const [appointment, setAppointment] = useState<Appointment | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    api<Doctor>(`/doctors/${doctorId}`).then((d) => {
      setDoctor(d);
      const dates = nextDates(d.tz).map((x) => x.value);
      setDate(initialDate && dates.includes(initialDate) ? initialDate : dates[0]);
    }, (e) => setMessage(errorText(e)));
  }, [doctorId, initialDate]);

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

  /** A 30-minute visit needs this slot AND the next one to be free and back to back. */
  const bookable = (i: number) => {
    const s = slots[i];
    if (s.status !== 'open' || new Date(s.start).getTime() <= now) return false;
    if (minutes === 15) return true;
    const next = slots[i + 1];
    return !!next && next.status === 'open' && next.start === s.end;
  };

  const holdSlot = (slotId: string) =>
    act(async (key) => {
      setAppointment(null);
      setHold(await api<Hold>('/holds', { method: 'POST', body: { slotId, patientId: patient!.id, durationMinutes: minutes }, idempotencyKey: key }));
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
  const fmt = new Intl.DateTimeFormat('en-IN', { timeZone: doctor.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const timeOnly = new Intl.DateTimeFormat('en-IN', { timeZone: doctor.tz, hour: '2-digit', minute: '2-digit' });
  const span = (start: string, end: string) => `${fmt.format(new Date(start))}–${timeOnly.format(new Date(end))}`;
  const heldIds = hold ? slots.filter((s) => s.start >= hold.start && s.end <= hold.end).map((s) => s.id) : [];

  return (
    <>
      <h1>{doctor.name}</h1>
      <p className="lede">
        {doctor.specialty} · {doctor.clinic}, {doctor.area} · ★ {doctor.rating} · {doctor.languages.join(', ')}
      </p>

      <section className="panel">
        <div className="controls">
          <label>
            Day{' '}
            <select value={date} onChange={(e) => setDate(e.target.value)}>
              {nextDates(doctor.tz).map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </label>
          <div className="toggle" role="group" aria-label="Visit length">
            {([15, 30] as const).map((m) => (
              <button key={m} className={minutes === m ? 'on' : ''} onClick={() => setMinutes(m)} disabled={!!hold}>
                {m} min
              </button>
            ))}
          </div>
        </div>

        {slots.length === 0 ? (
          <p className="muted">No slots this day (weekend, leave, or not materialized).</p>
        ) : (
          <div className="slots">
            {slots.map((s, i) => (
              <button
                key={s.id}
                className={`slot ${s.status}${heldIds.includes(s.id) ? ' mine' : ''}`}
                disabled={!bookable(i) || !!hold || !patient}
                onClick={() => holdSlot(s.id)}
                title={`${s.status} · ${s.start} UTC`}
              >
                {s.localTime}
              </button>
            ))}
          </div>
        )}
        <p className="muted small">
          Times in {doctor.tz}. Grey = held, booked or past. {minutes === 30 && 'A 30-minute visit uses this slot and the next one.'}
        </p>
      </section>

      {hold && (
        <section className="panel">
          <h2>Held for {patient?.name}</h2>
          <p>
            {span(hold.start, hold.end)} · expires in{' '}
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
          <p>{span(appointment.start, appointment.end)} · {appointment.visitType.replace('_', ' ')}</p>
          <p className="muted small">
            id {appointment.id} · <Link href="/me/appointments">My appointments →</Link>
          </p>
          {appointment.status === 'confirmed' && <button onClick={cancel}>Cancel appointment</button>}
        </section>
      )}

      {message && <p className="error">{message}</p>}
    </>
  );
}
