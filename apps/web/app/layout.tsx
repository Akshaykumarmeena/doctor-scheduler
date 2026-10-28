import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Doctor Scheduler',
  description: 'Book a doctor without double-booking.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
