'use client';

// Demo identity: no login yet (ADR 0002), so the header lets you pick which seeded patient you are.
// The choice is remembered in this browser only.
// Phase 4: also keeps the inbox unread count live over SSE (GET /patients/:id/stream).
import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Notification, Patient } from '@ds/shared';
import { api, API_URL } from './api';

const STORAGE_KEY = 'ds.patientId';

interface PatientState {
  patients: Patient[];
  patient: Patient | null;
  setPatientId: (id: string) => void;
  unread: number;
  /** Bumps on every live notification, so pages can refetch (inbox, My appointments). */
  inboxVersion: number;
  refreshInbox: () => void;
}

const PatientContext = createContext<PatientState>({
  patients: [],
  patient: null,
  setPatientId: () => {},
  unread: 0,
  inboxVersion: 0,
  refreshInbox: () => {},
});

export function PatientProvider({ children }: { children: ReactNode }) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientId, setId] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [inboxVersion, setInboxVersion] = useState(0);

  useEffect(() => {
    api<{ patients: Patient[] }>('/patients?limit=20')
      .then(({ patients }) => {
        setPatients(patients);
        let saved: string | null = null;
        try {
          saved = localStorage.getItem(STORAGE_KEY);
        } catch {
          // storage blocked (private window): fall back to the first patient
        }
        setId(patients.some((p) => p.id === saved) ? saved : (patients[0]?.id ?? null));
      })
      .catch(() => setPatients([]));
  }, []);

  const refreshInbox = useCallback(() => {
    if (!patientId) return;
    api<{ notifications: Notification[]; unread: number }>(`/patients/${patientId}/notifications?unread=true`)
      .then((r) => setUnread(r.unread))
      .catch(() => {});
  }, [patientId]);

  // Live: the server pushes "notification" events; the browser's EventSource reconnects by itself.
  useEffect(() => {
    if (!patientId) return;
    refreshInbox();
    const es = new EventSource(`${API_URL}/patients/${patientId}/stream`);
    es.addEventListener('notification', () => {
      refreshInbox();
      setInboxVersion((v) => v + 1);
    });
    return () => es.close();
  }, [patientId, refreshInbox]);

  const setPatientId = (id: string) => {
    setId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // not persisted; fine for a demo
    }
  };

  const patient = patients.find((p) => p.id === patientId) ?? null;
  return (
    <PatientContext.Provider value={{ patients, patient, setPatientId, unread, inboxVersion, refreshInbox }}>
      {children}
    </PatientContext.Provider>
  );
}

export const usePatient = () => useContext(PatientContext);

export function PatientSwitcher() {
  const { patients, patient, setPatientId } = usePatient();
  if (patients.length === 0) return null;
  return (
    <label className="switcher">
      <span className="muted small">You are</span>{' '}
      <select value={patient?.id ?? ''} onChange={(e) => setPatientId(e.target.value)}>
        {patients.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </label>
  );
}

export function InboxLink() {
  const { unread } = usePatient();
  return (
    <Link href="/me/inbox" aria-label={`Inbox, ${unread} unread`}>
      Inbox{unread > 0 && <span className="badge ok count">{unread}</span>}
    </Link>
  );
}
