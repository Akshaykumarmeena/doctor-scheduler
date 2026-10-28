import { HealthPanel } from './health-panel';

export default function Home() {
  return (
    <main>
      <h1>Doctor Scheduler</h1>
      <p className="lede">
        A scheduling platform that cannot double-book, keeps working when parts of it fail, and fills empty and
        no-show slots automatically.
      </p>
      <HealthPanel />
      <p className="muted">Phase 1: foundations. Search and booking arrive in later phases.</p>
    </main>
  );
}
