import pg from 'pg';
import { migrate } from '../../src/db/migrate';
import { TEST_OWNER_URL } from './env';

/** Rebuilds the test database from migrations once per run. */
export default async function setup() {
  const c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await c.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await c.end();
  await migrate(TEST_OWNER_URL, undefined, () => {});
}
