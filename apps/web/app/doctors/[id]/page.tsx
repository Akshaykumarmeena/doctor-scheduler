import Link from 'next/link';
import { BookingPanel } from './booking-panel';

export default async function DoctorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main>
      <p className="muted small"><Link href="/doctors">← Doctors</Link></p>
      <BookingPanel doctorId={id} />
    </main>
  );
}
