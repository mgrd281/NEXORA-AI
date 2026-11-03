/**
 * Schema invariants the API relies on for performance: every foreign key is
 * backed by an index on its referencing columns (cascading deletes and
 * per-step/per-task lookups would otherwise scan whole tables), and the
 * look-ups that have no foreign key are indexed too.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_OWNER_URL } from '../env';

let owner: pg.Client;
beforeAll(async () => {
  owner = new pg.Client({ connectionString: TEST_OWNER_URL });
  await owner.connect();
});
afterAll(async () => {
  await owner.end();
});

/** True when some non-partial index of `table` starts with exactly `columns` (any order). */
async function hasLeadingIndex(table: string, columns: string[]) {
  const r = await owner.query<{ ok: boolean }>(
    `select exists (
       select 1 from pg_index i
        where i.indrelid = $1::regclass and i.indpred is null
          and (select array_agg(a.attname::text order by a.attname)
                 from unnest((i.indkey::int2[])[0:cardinality($2::text[]) - 1]) k(attnum)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
              = (select array_agg(c order by c) from unnest($2::text[]) c)) as ok`,
    [table, columns],
  );
  return r.rows[0]!.ok;
}

describe('database indexes', () => {
  it('back every foreign key with an index on its referencing columns', async () => {
    const fks = await owner.query<{ tbl: string; cols: string[]; ref: string }>(
      `select c.conrelid::regclass::text as tbl, c.confrelid::regclass::text as ref,
              array_agg(a.attname::text order by k.n) as cols
         from pg_constraint c
         cross join lateral unnest(c.conkey) with ordinality k(attnum, n)
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
        where c.contype = 'f' and c.connamespace = 'public'::regnamespace
        group by c.oid, c.conrelid, c.confrelid`,
    );
    expect(fks.rows.length).toBeGreaterThan(40);
    const missing: string[] = [];
    for (const fk of fks.rows)
      if (!(await hasLeadingIndex(fk.tbl, fk.cols)))
        missing.push(`${fk.tbl}(${fk.cols.join(', ')}) -> ${fk.ref}`);
    expect(missing).toEqual([]);
  });

  it('index the account-deletion and step-claim look-ups', async () => {
    // DELETE FROM jobs WHERE user_id = … (jobs has no foreign keys by design).
    expect(await hasLeadingIndex('jobs', ['user_id'])).toBe(true);
    // UPDATE tool_executions … WHERE step_id = … AND status = 'started' (executor claim).
    expect(await hasLeadingIndex('tool_executions', ['step_id'])).toBe(true);
  });
});
