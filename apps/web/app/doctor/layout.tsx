import type { ReactNode } from 'react';
import { DoctorHeader, DoctorProvider } from './doctor-context';

export default function DoctorLayout({ children }: { children: ReactNode }) {
  return (
    <DoctorProvider>
      <main className="wide">
        <h1>Doctor app</h1>
        <DoctorHeader />
        {children}
      </main>
    </DoctorProvider>
  );
}
