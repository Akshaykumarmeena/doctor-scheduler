'use client';

// Live updates with a fallback (Phase 7).
//
//   1. PUSH: open a Server-Sent Events stream. The server sends "hello" at once and "ping" every 15 s.
//   2. If nothing arrives within 3 s, or the pings stop for 40 s, the push channel is dead: a proxy is holding the
//      stream back (the free Cloudflare quick tunnel does this). Then:
//   3. PULL: call onChange every second (the page refetches), and retry push every 60 s in the background.
//      When push works again, polling stops.
//
// Correctness never depends on this: onChange just means "refetch from the API", which is always the truth.
import { useEffect, useRef, useState } from 'react';

export type LiveMode = 'connecting' | 'live' | 'polling';

const HELLO_TIMEOUT_MS = 3_000;
const SILENCE_LIMIT_MS = 40_000; // pings come every 15 s
const RETRY_PUSH_MS = 60_000;

/** onChange gets 'push' for a real change event from the server, 'poll' for a routine poll while in fallback mode. */
export function useLiveUpdates(
  url: string | null,
  event: string,
  onChange: (source: 'push' | 'poll') => void,
  pollMs = 1_000,
): LiveMode {
  const [mode, setMode] = useState<LiveMode>('connecting');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!url) return;
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let lastHeard = 0;
    let stopped = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const heard = () => {
      lastHeard = Date.now();
      if (poll) {
        clearInterval(poll); // push works (again): stop polling
        poll = null;
      }
      setMode('live');
    };

    const startPolling = () => {
      if (stopped) return;
      if (!poll) {
        setMode('polling');
        poll = setInterval(() => onChangeRef.current('poll'), pollMs);
      }
      timers.push(setTimeout(openPush, RETRY_PUSH_MS)); // keep trying push in the background, every minute
    };

    function openPush() {
      if (stopped) return;
      es?.close();
      const opened = Date.now();
      es = new EventSource(url!);
      es.onmessage = heard; // "hello" / "ping"
      es.addEventListener(event, () => {
        heard();
        onChangeRef.current('push');
      });
      // Nothing within 3 s of opening: the stream is being held back.
      timers.push(
        setTimeout(() => {
          if (lastHeard < opened) {
            es?.close();
            startPolling();
          }
        }, HELLO_TIMEOUT_MS),
      );
    }

    // Pings stopped (the connection died silently): fall back too.
    const watchdog = setInterval(() => {
      if (!poll && lastHeard && Date.now() - lastHeard > SILENCE_LIMIT_MS) {
        es?.close();
        startPolling();
      }
    }, 5_000);

    openPush();
    return () => {
      stopped = true;
      es?.close();
      if (poll) clearInterval(poll);
      clearInterval(watchdog);
      timers.forEach(clearTimeout);
    };
  }, [url, event, pollMs]);

  return mode;
}

export function LiveBadge({ mode, pollMs = 1_000 }: { mode: LiveMode; pollMs?: number }) {
  const text = mode === 'live' ? '● live' : mode === 'polling' ? `↻ updating every ${pollMs / 1000} s` : '○ connecting…';
  const title =
    mode === 'polling'
      ? 'The live stream is blocked on this network (e.g. a tunnel), so the page asks for updates every second instead'
      : 'Updates from other users appear without reloading';
  return <span title={title}>{text}</span>;
}
