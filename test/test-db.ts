// Integration tests run against a throwaway `scheduler_test` database on the same server
// as DATABASE_URL, recreated from the schema files on every `npm test`.
const base = process.env.DATABASE_URL ?? 'postgres://scheduler:scheduler@localhost:5432/scheduler';

export function adminDatabaseUrl() {
  return base;
}

export function testDatabaseUrl() {
  const url = new URL(base);
  url.pathname = '/scheduler_test';
  return url.toString();
}
