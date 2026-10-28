import pg from 'pg';

// numeric (e.g. doctors.rating) comes back as a string by default; we only use small values.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

export function createPool(connectionString: string) {
  return new pg.Pool({ connectionString, max: 10 });
}

export type Pool = pg.Pool;
