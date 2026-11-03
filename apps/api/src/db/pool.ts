import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './types';

// int8 (bigint, count(*)) → number. Safe: our largest values are micro-USD sums
// and serial ids, far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric (percentile_cont etc.) → number
pg.types.setTypeParser(1700, (v) => Number(v));

export type Db = Kysely<Database>;
export type Trx = Transaction<Database>;

export function createDb(connectionString: string, max = 10): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}

/** Identity under which a transaction runs. RLS policies read these settings. */
export interface DbContext {
  tenantId: string;
  userId: string;
}

/**
 * Runs `fn` in a transaction scoped to one tenant and user. Row-Level Security
 * guarantees that every statement inside only sees and writes that user's rows.
 * This is the ONLY way application code should touch tenant data.
 */
export async function withContext<T>(
  db: Db,
  ctx: DbContext,
  fn: (trx: Trx) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.tenant_id', ${ctx.tenantId}, true), set_config('app.user_id', ${ctx.userId}, true)`.execute(
      trx,
    );
    return fn(trx);
  });
}

export async function pingDb(db: Db): Promise<boolean> {
  try {
    await sql`select 1`.execute(db);
    return true;
  } catch {
    return false;
  }
}
