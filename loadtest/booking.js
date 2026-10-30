/* global __ENV, __VU, __ITER */
// k6 load test: a realistic mix of what patients do. Run from the /console page (Docker image grafana/k6), or:
//   docker run --rm -i --add-host=host.docker.internal:host-gateway -v "$PWD/loadtest:/loadtest" \
//     -e BASE_URL=http://host.docker.internal:4000 grafana/k6:0.54.0 run /loadtest/booking.js
//
// Mix per iteration: 60% search · 20% slot grid · 15% hold -> confirm · 5% cancel one of this VU's bookings.
// 409 (slot taken, patient busy) is a correct answer under contention, not an error.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomItem } from './vendor.js';

const BASE = __ENV.BASE_URL || 'http://localhost:4000';

export const options = {
  vus: Number(__ENV.VUS || 20),
  duration: __ENV.DURATION || '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'], // < 1% errors
    http_req_duration: ['p(95)<300'], // 95% of requests under 300 ms
  },
};

// Treat 409 as an expected outcome (lost a race, already busy), so it doesn't count as a failed request.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409));

const TERMS = ['cardio', 'derma', 'ortho', 'pedia', 'neuro', 'ent', 'gyn', 'general', 'dent', 'psych'];

function localDate(daysAhead) {
  const d = new Date(Date.now() + 5.5 * 3600_000 + daysAhead * 86_400_000); // Asia/Kolkata
  return d.toISOString().slice(0, 10);
}

export function setup() {
  const patients = http.get(`${BASE}/patients?limit=100`).json('patients').map((p) => p.id);
  const doctors = http.get(`${BASE}/doctors?limit=100`).json('doctors').map((d) => d.id);
  return { patients, doctors };
}

const myBookings = []; // per VU

function key() {
  return `${__VU}-${__ITER}-${Math.random().toString(36).slice(2)}`;
}

function post(path, body) {
  const headers = { 'idempotency-key': key() };
  if (body) headers['content-type'] = 'application/json'; // no JSON content-type without a JSON body
  return http.post(`${BASE}${path}`, body ? JSON.stringify(body) : null, {
    headers,
    tags: { name: path.replace(/[0-9a-f-]{36}/g, ':id') },
  });
}

export default function (data) {
  const r = Math.random();
  const date = localDate(1 + Math.floor(Math.random() * 10));

  if (r < 0.6) {
    const res = http.get(`${BASE}/search?q=${randomItem(TERMS)}&date=${date}&pageSize=10`, { tags: { name: '/search' } });
    check(res, { 'search 200': (x) => x.status === 200 });
  } else if (r < 0.8) {
    const res = http.get(`${BASE}/doctors/${randomItem(data.doctors)}/slots?date=${date}`, { tags: { name: '/doctors/:id/slots' } });
    check(res, { 'grid 200': (x) => x.status === 200 });
  } else if (r < 0.95) {
    const doctor = randomItem(data.doctors);
    const grid = http.get(`${BASE}/doctors/${doctor}/slots?date=${date}`, { tags: { name: '/doctors/:id/slots' } });
    const open = (grid.json('slots') || []).filter((s) => s.status === 'open');
    if (open.length > 0) {
      const hold = post('/holds', { slotId: randomItem(open).id, patientId: randomItem(data.patients) });
      check(hold, { 'hold 201 or 409': (x) => x.status === 201 || x.status === 409 });
      if (hold.status === 201) {
        const appt = post('/appointments', { holdId: hold.json('holdId'), visitType: 'in_person' });
        check(appt, { 'confirm 201': (x) => x.status === 201 });
        if (appt.status === 201) myBookings.push(appt.json('id'));
      }
    }
  } else if (myBookings.length > 0) {
    const res = post(`/appointments/${myBookings.shift()}/cancel`);
    check(res, { 'cancel 200': (x) => x.status === 200 });
  }
  sleep(0.2 + Math.random() * 0.3);
}
