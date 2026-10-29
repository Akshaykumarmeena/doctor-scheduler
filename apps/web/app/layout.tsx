import type { ReactNode } from 'react';
import Link from 'next/link';
import { InboxLink, PatientProvider, PatientSwitcher } from './patient';
import './globals.css';

export const metadata = {
  title: 'Doctor Scheduler',
  description: 'Book a doctor without double-booking.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PatientProvider>
          <header className="topbar">
            <nav>
              <Link href="/" className="brand">Doctor Scheduler</Link>
              <Link href="/search">Find a doctor</Link>
              <Link href="/me/appointments">My appointments</Link>
              <InboxLink />
              <Link href="/doctor/week">Doctor app</Link>
              <Link href="/console">Console</Link>
            </nav>
            <PatientSwitcher />
          </header>
          {children}
        </PatientProvider>
      </body>
    </html>
  );
}
