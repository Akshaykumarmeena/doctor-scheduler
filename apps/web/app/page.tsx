import Link from 'next/link';
import { HealthPanel } from './health-panel';

export default function Home() {
  return (
    <main>
      <h1>Doctor Scheduler</h1>
      <p className="lede">
        A scheduling platform that cannot double-book, keeps working when parts of it fail, and fills empty and
        no-show slots automatically.
      </p>
      <p>
        <Link href="/doctors">Book a doctor →</Link>
      </p>
      <HealthPanel />
      <p className="muted">Phase 2: holds, confirm, cancel, idempotency and the outbox. Search arrives in a later phase.</p>
    </main>
  );
}
