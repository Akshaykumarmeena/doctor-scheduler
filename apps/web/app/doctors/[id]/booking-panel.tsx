'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { Appointment, Doctor, Hold, SlotView, WaitlistEntry } from '@ds/shared';
import { api, ApiFailure, API_URL } from '../../api';
import { LiveBadge, useLiveUpdates } from '../../live';
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

const LEASE_SECONDS = 120;
const HEARTBEAT_MS = 30_000;

/** Plain-language messages for the errors a patient can actually cause. */
const FRIENDLY: Record<string, string> = {
  patient_busy: 'Busy: you already have an appointment (or a hold) at this time.',
  too_many_holds: 'You are already holding 3 slots. Confirm or release one first.',
};

function errorText(err: unknown) {
  if (err instanceof ApiFailure) return FRIENDLY[err.body.error] ?? `${err.status} ${err.body.error}: ${err.body.message}`;
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
  const [notice, setNotice] = useState<string | null>(null);
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

  // Live: someone else holds, books or cancels on this day -> the server pushes "slots-changed" -> refetch.
  // Through a proxy that blocks streams, live.tsx falls back to refetching every second.
  const liveMode = useLiveUpdates(date ? `${API_URL}/doctors/${doctorId}/slots/stream?date=${date}` : null, 'slots-changed', () => {
    loadSlots().catch(() => {});
  });

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Reopened tab: if this patient still has a live hold with this doctor, pick it back up.
  useEffect(() => {
    if (!patient) return;
    api<{ holds: Hold[] }>(`/patients/${patient.id}/holds`)
      .then((r) => setHold(r.holds.find((h) => h.doctorId === doctorId) ?? null))
      .catch(() => {});
  }, [patient, doctorId]);

  // Closed-tab lease: while this page is open, renew the 2-minute lease every 30 s (up to the 5-minute deadline).
  // Close the tab and the renewals stop, so the hold lapses within 2 minutes and the slot frees up.
  const holdId = hold?.holdId;
  useEffect(() => {
    if (!holdId) return;
    const beat = setInterval(() => {
      api<Hold>(`/holds/${holdId}/heartbeat`, { method: 'POST', body: { leaseSeconds: LEASE_SECONDS }, idempotencyKey: crypto.randomUUID() })
        .then(setHold)
        .catch(() => {}); // lapsed: the countdown runs out and Confirm turns off
    }, HEARTBEAT_MS);
    return () => clearInterval(beat);
  }, [holdId]);

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
      setHold(
        await api<Hold>('/holds', {
          method: 'POST',
          body: { slotId, patientId: patient!.id, durationMinutes: minutes, leaseSeconds: LEASE_SECONDS },
          idempotencyKey: key,
        }),
      );
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
  const joinWaitlist = () =>
    act(async (key) => {
      const entry = await api<WaitlistEntry>('/waitlist', {
        method: 'POST',
        body: { doctorId, patientId: patient!.id, date },
        idempotencyKey: key,
      });
      setNotice(`You're on the waitlist for ${entry.date}. If a slot frees up, it's held for you and you'll get a message.`);
    });
  const cancel = () =>
    act(async (key) => {
      setAppointment(await api<Appointment>(`/appointments/${appointment!.id}/cancel`, { method: 'POST', idempotencyKey: key }));
    });

  if (!doctor) return <p className="muted">{message ?? 'Loading…'}</p>;
  // The countdown shows the 5-minute deadline; the 2-minute lease only matters once the tab is closed.
  const secondsLeft = hold ? Math.max(0, Math.round((new Date(hold.deadlineAt).getTime() - now) / 1000)) : 0;
  const fmt = new Intl.DateTimeFormat('en-IN', { timeZone: doctor.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const timeOnly = new Intl.DateTimeFormat('en-IN', { timeZone: doctor.tz, hour: '2-digit', minute: '2-digit' });
  const span = (start: string, end: string) => `${fmt.format(new Date(start))}–${timeOnly.format(new Date(end))}`;
  const nothingFree = slots.length > 0 && slots.every((s) => s.status !== 'open' || new Date(s.start).getTime() <= now);
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
          Times in {doctor.tz}. Grey = held, booked or past. {minutes === 30 && 'A 30-minute visit uses this slot and the next one.'}{' '}
          <LiveBadge mode={liveMode} />
        </p>
        {nothingFree && !hold && (
          <div className="controls">
            <span>Nothing free this day.</span>
            <button onClick={joinWaitlist} disabled={!patient}>Join waitlist for this day</button>
          </div>
        )}
        {notice && <p className="small">{notice}</p>}
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
