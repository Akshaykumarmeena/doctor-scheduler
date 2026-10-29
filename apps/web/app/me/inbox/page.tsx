'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { Notification } from '@ds/shared';
import { api } from '../../api';
import { usePatient } from '../../patient';

const fmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function InboxPage() {
  const { patient, inboxVersion, refreshInbox } = usePatient();
  const [items, setItems] = useState<Notification[] | null>(null);

  const load = useCallback(async () => {
    if (!patient) return;
    const r = await api<{ notifications: Notification[] }>(`/patients/${patient.id}/notifications`);
    setItems(r.notifications);
  }, [patient]);

  useEffect(() => {
    load().catch(() => setItems([]));
  }, [load, inboxVersion]); // inboxVersion bumps on every live notification

  const markRead = async (id: string) => {
    await api(`/notifications/${id}/read`, { method: 'POST', idempotencyKey: crypto.randomUUID() });
    await load();
    refreshInbox();
  };

  return (
    <main>
      <h1>Inbox</h1>
      <p className="lede">{patient ? `Messages for ${patient.name}. New ones appear live.` : 'Loading…'}</p>
      {items?.length === 0 && <p className="muted">Nothing yet. Book, cancel, or join a waitlist to get messages.</p>}
      {items?.map((n) => (
        <section key={n.id} className={`panel result${n.readAt ? ' read' : ''}`}>
          <div>
            <div className="name">
              {n.title} {!n.readAt && <span className="badge ok">new</span>}
            </div>
            <div className="muted">{n.body}</div>
            <div className="muted small">
              {fmt.format(new Date(n.createdAt))}
              {n.kind === 'offer' && (
                <>
                  {' · '}
                  <Link href="/me/appointments">Respond in My appointments →</Link>
                </>
              )}
            </div>
          </div>
          {!n.readAt && <button onClick={() => markRead(n.id)}>Mark read</button>}
        </section>
      ))}
    </main>
  );
}
