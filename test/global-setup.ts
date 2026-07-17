import { execSync } from 'node:child_process';
import { Client } from 'pg';
import * as dotenv from 'dotenv';

/**
 * Creates the test database if absent and brings it up to the current migration
 * head. Runs once before the suite.
 *
 * Tests run against a real Postgres, not a mock. A mocked ledger would prove
 * nothing: the invariants under test are enforced by row locks, a unique
 * constraint and real transactions.
 */
export default async function globalSetup(): Promise<void> {
  dotenv.config();

  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error('TEST_DATABASE_URL is not set — copy .env.example to .env');
  }

  const parsed = new URL(testUrl);
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!dbName) throw new Error(`TEST_DATABASE_URL has no database name: ${testUrl}`);

  // Guard: never let a stray config point the destructive test suite at the
  // development or production database.
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to run tests against database "${dbName}" — its name must contain "test".`);
  }

  const adminUrl = new URL(testUrl);
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) {
      await admin.query(`CREATE DATABASE "${dbName}"`);
      console.log(`\n  created test database ${dbName}`);
    }
  } finally {
    await admin.end();
  }

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });
}
