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
        <Link href="/search">Find a doctor →</Link> · <Link href="/me/appointments">My appointments</Link>
      </p>
      <HealthPanel />
      <p className="muted">Phase 3: search (OpenSearch read model fed by Kafka), patient screens and 30-minute visits.</p>
    </main>
  );
}
