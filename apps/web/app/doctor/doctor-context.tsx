'use client';

// Demo identity for the doctor side (no login yet): pick which doctor you are; remembered in this browser only.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Doctor, SearchResponse } from '@ds/shared';
import { api } from '../api';

const STORAGE_KEY = 'ds.doctorId';
const DEFAULT_DOCTOR = '00b6826f-d1a5-40f2-b3fa-4990bb2706b9'; // Dr. Shreya Kulkarni: has demo bookings

interface DoctorState {
  doctor: Doctor | null;
  setDoctorId: (id: string) => void;
}

const DoctorContext = createContext<DoctorState>({ doctor: null, setDoctorId: () => {} });
export const useDoctor = () => useContext(DoctorContext);

export function DoctorProvider({ children }: { children: ReactNode }) {
  const [doctorId, setId] = useState<string | null>(null);
  const [doctor, setDoctor] = useState<Doctor | null>(null);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      // storage blocked: use the default
    }
    setId(saved ?? DEFAULT_DOCTOR);
  }, []);

  useEffect(() => {
    if (doctorId) api<Doctor>(`/doctors/${doctorId}`).then(setDoctor, () => setDoctor(null));
  }, [doctorId]);

  const setDoctorId = (id: string) => {
    setId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // not persisted; fine for a demo
    }
  };
  return <DoctorContext.Provider value={{ doctor, setDoctorId }}>{children}</DoctorContext.Provider>;
}

const TABS = [
  { href: '/doctor/week', label: 'Week' },
  { href: '/doctor/hours', label: 'Working hours' },
  { href: '/doctor/time-off', label: 'Time off' },
  { href: '/doctor/stats', label: 'Numbers' },
];

export function DoctorHeader() {
  const { doctor, setDoctorId } = useDoctor();
  const path = usePathname();
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState<Doctor[]>([]);

  useEffect(() => {
    if (q.trim().length < 2) return setMatches([]);
    const t = setTimeout(() => {
      api<SearchResponse>(`/search?q=${encodeURIComponent(q)}&pageSize=8`).then(
        (r) => setMatches(r.results.map((x) => x.doctor)),
        () => setMatches([]),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <section className="panel">
      <div className="controls">
        <strong>{doctor ? `You are ${doctor.name}` : 'Loading…'}</strong>
        <span className="muted small">{doctor && `${doctor.specialty} · ${doctor.clinic}, ${doctor.area}`}</span>
      </div>
      <div className="controls">
        <input className="searchbox" placeholder="Switch doctor: type a name…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {matches.length > 0 && (
        <ul className="list">
          {matches.map((d) => (
            <li key={d.id}>
              <button onClick={() => (setDoctorId(d.id), setQ(''), setMatches([]))}>
                {d.name} · {d.specialty} · {d.area}
              </button>
            </li>
          ))}
        </ul>
      )}
      <nav className="tabs">
        {TABS.map((t) => (
          <Link key={t.href} href={t.href} className={path === t.href ? 'on' : ''}>
            {t.label}
          </Link>
        ))}
      </nav>
    </section>
  );
}
