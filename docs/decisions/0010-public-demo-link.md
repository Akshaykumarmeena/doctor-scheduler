# 0010 – A temporary public demo link, safely

Status: accepted (Phase 7, 2026-10-30; decisions by Akshay)

## Context

Interviewers may want to click around themselves. The app runs on a laptop. Exposing it must not expose anything
that can damage the machine or the demo, and it must be free.

## Decisions

1. **Cloudflare quick tunnel** (`cloudflare/cloudflared:2024.10.0` from Docker; no account, nothing installed):
   a random `https://*.trycloudflare.com` URL that forwards to the web app on :3000. It runs attached to
   `npm run demo`, so Ctrl+C closes the public link.
2. **Only the web app is exposed.** The browser calls the API same-origin (`/api/*`, forwarded by Next.js), so a
   remote visitor never needs `localhost:4000`. The ops service (stop/start, load tests) is never exposed: it binds
   to 127.0.0.1, and `/console` shows "local only" over the public link.
3. **Per-visitor rate limit** in nginx, keyed by Cloudflare's `CF-Connecting-IP`: 10 requests/s, burst 20, then
   429. Requests without that header (local use, k6) aren't limited. Measured through the tunnel: 200 rapid
   requests → 112 allowed, 88 × 429.
4. **Next.js compression off** (`compress: false`): gzip buffered the proxied SSE streams. Cloudflare compresses
   pages at its edge anyway.
5. **`npm run demo:reset`** returns the data to a known state before each demo (admin script, documented exception
   to "only booking-api writes slots").

## Consequences

- **Live updates (SSE) don't stream through the free quick tunnel**: headers arrive, data doesn't, even when the
  tunnel points straight at nginx (proven). **Decision (Akshay): fall back to 1-second polling.** The stream now sends
  browser-visible heartbeats ("hello" on connect, "ping" every 15 s); `apps/web/app/live.tsx` switches to refetching
  every second if it hears nothing within 3 s (or no ping for 40 s), and retries push every minute. Measured over the
  public link: a hold made by another client appeared on the polling page 469 ms after it was confirmed. On
  localhost the page stays on push ("● live"). Named tunnel and long polling were the rejected alternatives (a domain
  costs money; long polling is more code for ~0.5 s of gain).
- No authentication: anyone with the URL can book. Acceptable for a temporary, random, rate-limited demo URL; never
  for production.
