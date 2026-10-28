import pg from 'pg';
import { runMigrations } from '../db/migrate.js';
import { adminDatabaseUrl, testDatabaseUrl } from './test-db.js';

export default async function setup() {
  const admin = new pg.Client({ connectionString: adminDatabaseUrl() });
  await admin.connect();
  try {
    await admin.query('DROP DATABASE IF EXISTS scheduler_test WITH (FORCE)');
    await admin.query('CREATE DATABASE scheduler_test');
  } finally {
    await admin.end();
  }
  await runMigrations(testDatabaseUrl(), () => {});
}
