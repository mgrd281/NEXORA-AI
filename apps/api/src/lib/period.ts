import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types';

/**
 * The current calendar month in the user's time zone, as absolute instants.
 * Budgets, usage and cost reports all use this one definition, so what the
 * Policy Engine enforces is exactly what the user sees in Settings.
 * Falls back to UTC for an unknown time zone.
 */
export async function currentMonth(
  db: Kysely<Database>,
  timeZone: string,
): Promise<{ start: Date; end: Date }> {
  const query = (tz: string) =>
    sql<{ start: Date; end: Date }>`
      select date_trunc('month', now() at time zone ${tz}) at time zone ${tz} as start,
             (date_trunc('month', now() at time zone ${tz}) + interval '1 month') at time zone ${tz} as end`.execute(
      db,
    );
  let res;
  try {
    res = await query(timeZone);
  } catch {
    res = await query('UTC');
  }
  const row = res.rows[0]!;
  return { start: new Date(row.start), end: new Date(row.end) };
}
