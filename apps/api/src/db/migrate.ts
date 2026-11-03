/**
 * Minimal, transactional SQL migration runner.
 *   - Applies db/migrations/*.sql in lexical order, each in its own transaction.
 *   - Records filename + SHA-256 in schema_migrations; refuses to run if an
 *     applied file was modified afterwards.
 *   - Serialised with an advisory lock so concurrent deploys cannot race.
 * Runs as the owner role (DATABASE_OWNER_URL).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sha256Hex } from '../lib/crypto';

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../db/migrations',
);
const LOCK_ID = 7_314_159;

export async function migrate(
  ownerUrl: string,
  dir = MIGRATIONS_DIR,
  log = console.log,
): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (
        await client.query<{ filename: string; checksum: string }>(
          'SELECT filename, checksum FROM schema_migrations',
        )
      ).rows.map((r) => [r.filename, r.checksum]),
    );
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();
    for (const file of files) {
      const body = readFileSync(join(dir, file), 'utf8');
      const checksum = sha256Hex(body);
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum)
          throw new Error(`Migration ${file} was modified after being applied`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(body);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) {
    console.error('DATABASE_OWNER_URL is required');
    process.exit(1);
  }
  migrate(url)
    .then((a) =>
      console.log(a.length ? `${a.length} migration(s) applied` : 'database is up to date'),
    )
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
