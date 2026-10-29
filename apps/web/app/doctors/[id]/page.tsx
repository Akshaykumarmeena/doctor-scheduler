import Link from 'next/link';
import { BookingPanel } from './booking-panel';

export default async function DoctorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { id } = await params;
  const { date } = await searchParams;
  return (
    <main>
      <p className="muted small"><Link href="/search">← Search</Link></p>
      <BookingPanel doctorId={id} initialDate={date} />
    </main>
  );
}
