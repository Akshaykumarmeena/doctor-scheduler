// Seeds ~5,000 synthetic Bengaluru doctors (with weekly templates and a few leave days) and ~300 patients.
// Deterministic content (fixed PRNG seed). Skips if doctors already exist, so re-running is safe.
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DOCTORS = 5000;
const PATIENTS = 300;

// mulberry32: tiny seeded PRNG so every run produces the same data.
function prng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(20261028);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];

const AREAS: Record<string, [number, number]> = {
  Indiranagar: [12.9719, 77.6412],
  Koramangala: [12.9352, 77.6245],
  'HSR Layout': [12.9116, 77.6474],
  Whitefield: [12.9698, 77.75],
  Jayanagar: [12.9308, 77.5838],
  'JP Nagar': [12.9063, 77.5857],
  'BTM Layout': [12.9166, 77.6101],
  Malleshwaram: [13.0031, 77.5643],
  Rajajinagar: [12.991, 77.552],
  Hebbal: [13.0358, 77.597],
  Marathahalli: [12.9569, 77.7011],
  'Electronic City': [12.8452, 77.6602],
  Bellandur: [12.926, 77.6762],
  Yelahanka: [13.1007, 77.5963],
  Banashankari: [12.9255, 77.5468],
  Basavanagudi: [12.9422, 77.5738],
};
const SPECIALTIES = [
  'General Physician', 'Pediatrics', 'Dermatology', 'Cardiology', 'Orthopedics',
  'Gynecology', 'ENT', 'Ophthalmology', 'Dentistry', 'Psychiatry',
  'Neurology', 'Gastroenterology', 'Endocrinology', 'Pulmonology', 'Urology',
] as const;
const FIRST = [
  'Aarav', 'Aditi', 'Akshay', 'Ananya', 'Arjun', 'Bhavana', 'Chetan', 'Deepa', 'Divya', 'Ganesh',
  'Harish', 'Isha', 'Karthik', 'Kavya', 'Lakshmi', 'Manish', 'Meera', 'Mohan', 'Nandini', 'Naveen',
  'Pooja', 'Prakash', 'Priya', 'Rahul', 'Ramesh', 'Rekha', 'Rohan', 'Sanjay', 'Shalini', 'Shreya',
  'Srinivas', 'Suresh', 'Swati', 'Tanvi', 'Varun', 'Vidya', 'Vikram', 'Yamuna', 'Zoya', 'Farhan',
  'Ayesha', 'Joseph', 'Mary', 'Gurpreet', 'Harpreet', 'Sneha', 'Abhishek', 'Ritu', 'Sunil', 'Anil',
];
const LAST = [
  'Rao', 'Reddy', 'Iyer', 'Iyengar', 'Shetty', 'Hegde', 'Gowda', 'Nair', 'Menon', 'Pillai',
  'Kumar', 'Sharma', 'Verma', 'Gupta', 'Patel', 'Joshi', 'Kulkarni', 'Deshpande', 'Bhat', 'Kamath',
  'Naidu', 'Chowdhury', 'Banerjee', 'Mukherjee', 'Das', 'Singh', 'Khan', 'Fernandes', "D'Souza", 'Thomas',
];
const CLINIC_SUFFIX = ['Clinic', 'Health Centre', 'Medical Centre', 'Polyclinic', 'Hospital', 'Family Clinic'];
const EXTRA_LANGUAGES = ['Kannada', 'Hindi', 'Tamil', 'Telugu', 'Malayalam', 'Marathi', 'Bengali', 'Urdu'];

function languages() {
  const langs = new Set(['English']);
  if (rand() < 0.7) langs.add('Kannada');
  const extra = Math.floor(rand() * 3);
  for (let i = 0; i < extra; i++) langs.add(pick(EXTRA_LANGUAGES));
  return [...langs].join(',');
}

export async function seed(databaseUrl: string, log: (msg: string) => void = console.log) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const existing = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM doctors');
    if (existing.rows[0].n > 0) {
      log(`already seeded (${existing.rows[0].n} doctors); nothing to do`);
      return;
    }
    await client.query('BEGIN');

    // Doctors: built as parallel arrays and inserted with one unnest() statement.
    const cols = { name: [] as string[], specialty: [] as string[], clinic: [] as string[], area: [] as string[],
      lat: [] as number[], lng: [] as number[], languages: [] as string[], rating: [] as number[] };
    const areaNames = Object.keys(AREAS);
    for (let i = 0; i < DOCTORS; i++) {
      const last = pick(LAST);
      const area = pick(areaNames);
      const [lat, lng] = AREAS[area];
      cols.name.push(`Dr. ${pick(FIRST)} ${last}`);
      cols.specialty.push(pick(SPECIALTIES));
      cols.clinic.push(rand() < 0.5 ? `${last} ${pick(CLINIC_SUFFIX)}` : `${area} ${pick(CLINIC_SUFFIX)}`);
      cols.area.push(area);
      // Scatter within ~2 km of the area centre.
      cols.lat.push(Number((lat + (rand() - 0.5) * 0.036).toFixed(6)));
      cols.lng.push(Number((lng + (rand() - 0.5) * 0.036).toFixed(6)));
      cols.languages.push(languages());
      cols.rating.push(Number((3 + rand() * 2).toFixed(1)));
    }
    const doctors = await client.query<{ id: string }>(
      `INSERT INTO doctors (name, specialty, clinic, area, lat, lng, languages, rating, tz)
       SELECT name, specialty, clinic, area, lat, lng, string_to_array(langs, ','), rating, 'Asia/Kolkata'
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::float8[], $6::float8[], $7::text[], $8::numeric[])
              AS t(name, specialty, clinic, area, lat, lng, langs, rating)
       RETURNING id`,
      [cols.name, cols.specialty, cols.clinic, cols.area, cols.lat, cols.lng, cols.languages, cols.rating],
    );
    const ids = doctors.rows.map((r) => r.id);

    // Templates: everyone Mon-Fri 09:00-13:00; ~40% also 16:00-19:00 on Mon/Wed/Fri or Tue/Thu. 15-min slots.
    const t = { doctor: [] as string[], weekday: [] as number[], start: [] as string[], end: [] as string[] };
    const add = (doctor: string, weekday: number, start: string, end: string) => {
      t.doctor.push(doctor); t.weekday.push(weekday); t.start.push(start); t.end.push(end);
    };
    for (const id of ids) {
      for (let wd = 1; wd <= 5; wd++) add(id, wd, '09:00', '13:00');
      if (rand() < 0.4) for (const wd of rand() < 0.5 ? [1, 3, 5] : [2, 4]) add(id, wd, '16:00', '19:00');
    }
    await client.query(
      `INSERT INTO schedule_templates (doctor_id, weekday, start_local, end_local, slot_minutes, valid_from)
       SELECT doctor_id, weekday, start_local, end_local, 15, current_date
         FROM unnest($1::uuid[], $2::int[], $3::time[], $4::time[]) AS t(doctor_id, weekday, start_local, end_local)`,
      [t.doctor, t.weekday, t.start, t.end],
    );

    // Leave: every 50th doctor takes one whole local day off in the next two weeks (exercises exceptions).
    await client.query(
      `INSERT INTO schedule_exceptions (doctor_id, during, kind, reason)
       SELECT id,
              tstzrange(((now() AT TIME ZONE tz)::date + (rn % 14))::timestamp AT TIME ZONE tz,
                        ((now() AT TIME ZONE tz)::date + (rn % 14) + 1)::timestamp AT TIME ZONE tz, '[)'),
              'leave', 'Personal leave'
         FROM (SELECT id, tz, (row_number() OVER (ORDER BY id))::int AS rn FROM doctors) d
        WHERE rn % 50 = 0`,
    );

    // Patients.
    const p = { name: [] as string[], phone: [] as string[], lang: [] as string[] };
    for (let i = 0; i < PATIENTS; i++) {
      p.name.push(`${pick(FIRST)} ${pick(LAST)}`);
      p.phone.push(`+9198${String(10_000_000 + i).padStart(8, '0')}`);
      p.lang.push(rand() < 0.5 ? 'English' : pick(EXTRA_LANGUAGES));
    }
    await client.query(
      `INSERT INTO patients (name, phone, preferred_language)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[])`,
      [p.name, p.phone, p.lang],
    );

    await client.query('COMMIT');
    log(`seeded ${ids.length} doctors, ${t.doctor.length} templates, ${PATIENTS} patients`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL ?? 'postgres://scheduler:scheduler@localhost:5432/scheduler';
  seed(url).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
