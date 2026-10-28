import Link from 'next/link';
import type { Doctor } from '@ds/shared';
import { api } from '../api';

export const dynamic = 'force-dynamic';

export default async function DoctorsPage() {
  const { doctors } = await api<{ doctors: Doctor[] }>('/doctors?limit=50');
  return (
    <main>
      <p className="muted small"><Link href="/">← Home</Link></p>
      <h1>Doctors</h1>
      <p className="lede">First 50 of 5,000 synthetic Bengaluru doctors. Search arrives with OpenSearch in a later phase.</p>
      <ul className="list">
        {doctors.map((d) => (
          <li key={d.id}>
            <Link href={`/doctors/${d.id}`}>{d.name}</Link>
            <span className="muted"> · {d.specialty} · {d.area} · ★ {d.rating}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
