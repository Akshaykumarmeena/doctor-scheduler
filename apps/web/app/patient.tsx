'use client';

// Demo identity: no login yet (ADR 0002), so the header lets you pick which seeded patient you are.
// The choice is remembered in this browser only.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Patient } from '@ds/shared';
import { api } from './api';

const STORAGE_KEY = 'ds.patientId';

interface PatientState {
  patients: Patient[];
  patient: Patient | null;
  setPatientId: (id: string) => void;
}

const PatientContext = createContext<PatientState>({ patients: [], patient: null, setPatientId: () => {} });

export function PatientProvider({ children }: { children: ReactNode }) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientId, setId] = useState<string | null>(null);

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

  const setPatientId = (id: string) => {
    setId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // not persisted; fine for a demo
    }
  };

  const patient = patients.find((p) => p.id === patientId) ?? null;
  return <PatientContext.Provider value={{ patients, patient, setPatientId }}>{children}</PatientContext.Provider>;
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
