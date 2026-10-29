'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { SearchFacets, SearchResponse, SearchSort } from '@ds/shared';
import { api, ApiFailure } from '../api';

const TZ = 'Asia/Kolkata';
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayLabel = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const slotLabel = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const DATES = Array.from({ length: 14 }, (_, i) => {
  const d = new Date(Date.now() + i * 86_400_000);
  return { value: dateFmt.format(d), label: dayLabel.format(d) };
});

interface Filters {
  q: string;
  specialty: string;
  language: string;
  date: string;
  area: string;
  near: boolean;
  radiusKm: number;
  sort: SearchSort;
}

const INITIAL: Filters = { q: '', specialty: '', language: '', date: '', area: '', near: false, radiusKm: 3, sort: 'relevance' };

export default function SearchPage() {
  const [facets, setFacets] = useState<SearchFacets | null>(null);
  const [f, setF] = useState<Filters>(INITIAL);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SearchFacets>('/search/facets').then(setFacets, (e) => setError((e as Error).message));
  }, []);

  // Search as you type/filter, debounced so we do not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      const qs = new URLSearchParams();
      if (f.q.trim()) qs.set('q', f.q.trim());
      if (f.specialty) qs.set('specialty', f.specialty);
      if (f.language) qs.set('language', f.language);
      if (f.date) qs.set('date', f.date);
      const area = facets?.areas.find((a) => a.name === f.area);
      if (area && f.near) {
        qs.set('lat', String(area.lat));
        qs.set('lng', String(area.lng));
        qs.set('radiusKm', String(f.radiusKm));
      } else if (f.area) {
        qs.set('area', f.area);
      }
      qs.set('sort', f.sort === 'distance' && !(area && f.near) ? 'relevance' : f.sort);
      api<SearchResponse>(`/search?${qs}`).then(
        (r) => {
          setRes(r);
          setError(null);
        },
        (e) => setError(e instanceof ApiFailure ? e.body.message : (e as Error).message),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [f, facets]);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((prev) => ({ ...prev, [k]: v }));

  return (
    <main className="wide">
      <h1>Find a doctor</h1>
      <section className="panel">
        <input
          className="searchbox"
          placeholder="Name, specialty, clinic or area: try 'cardio', 'priya', 'koramangala'"
          value={f.q}
          onChange={(e) => set('q', e.target.value)}
          autoFocus
        />
        <div className="controls">
          <select value={f.specialty} onChange={(e) => set('specialty', e.target.value)} aria-label="Specialty">
            <option value="">Any specialty</option>
            {facets?.specialties.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={f.language} onChange={(e) => set('language', e.target.value)} aria-label="Language">
            <option value="">Any language</option>
            {facets?.languages.map((l) => <option key={l}>{l}</option>)}
          </select>
          <select value={f.date} onChange={(e) => set('date', e.target.value)} aria-label="Free on">
            <option value="">Any day</option>
            {DATES.map((d) => <option key={d.value} value={d.value}>Free on {d.label}</option>)}
          </select>
          <select value={f.area} onChange={(e) => set('area', e.target.value)} aria-label="Area">
            <option value="">Anywhere in Bengaluru</option>
            {facets?.areas.map((a) => <option key={a.name}>{a.name}</option>)}
          </select>
          {f.area && (
            <label className="small">
              <input type="checkbox" checked={f.near} onChange={(e) => set('near', e.target.checked)} /> within{' '}
              <select value={f.radiusKm} onChange={(e) => set('radiusKm', Number(e.target.value))} disabled={!f.near}>
                {[1, 3, 5, 10].map((k) => <option key={k} value={k}>{k} km</option>)}
              </select>
            </label>
          )}
          <select value={f.sort} onChange={(e) => set('sort', e.target.value as SearchSort)} aria-label="Sort">
            <option value="relevance">Best match</option>
            <option value="soonest">Soonest available</option>
            <option value="rating">Highest rated</option>
            <option value="distance" disabled={!(f.area && f.near)}>Nearest</option>
          </select>
          {JSON.stringify(f) !== JSON.stringify(INITIAL) && <button onClick={() => setF(INITIAL)}>Clear</button>}
        </div>
      </section>

      {error && <p className="error">{error}</p>}
      {res && (
        <p className="muted small">
          {res.total.toLocaleString('en-IN')} doctors · {res.tookMs} ms in OpenSearch · availability may lag bookings by a few seconds
        </p>
      )}
      <ul className="results">
        {res?.results.map((r) => (
          <li key={r.doctor.id} className="panel result">
            <div>
              <Link href={`/doctors/${r.doctor.id}${f.date ? `?date=${f.date}` : ''}`} className="name">{r.doctor.name}</Link>
              <div className="muted">
                {r.doctor.specialty} · {r.doctor.clinic}, {r.doctor.area}
                {r.distanceKm !== null && ` · ${r.distanceKm} km`}
              </div>
              <div className="muted small">★ {r.doctor.rating} · {r.doctor.languages.join(', ')}</div>
            </div>
            <div className="next">
              {r.nextAvailable ? (
                <>
                  <span className="muted small">Next free</span>
                  <strong>{slotLabel.format(new Date(r.nextAvailable))}</strong>
                </>
              ) : (
                <span className="muted small">No free slots in 14 days</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
