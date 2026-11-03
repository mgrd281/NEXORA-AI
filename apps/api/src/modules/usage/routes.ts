import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../../db/pool';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import type { AppDeps } from '../../services';
import { resolvePreferences } from '../account/me';

const MICRO_PER_USD = 1_000_000;

/**
 * The calendar month containing `now` in the user's time zone, as UTC
 * instants. Postgres does the calendar math, so DST transitions are exact.
 * Falls back to UTC if the stored zone is unknown to Postgres.
 */
export async function currentMonth(db: Db, timeZone: string): Promise<{ start: Date; end: Date }> {
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

/** Task outcome buckets; 'failed' matches the task list's "failed" filter. */
const FAILED_STATUSES = ['FAILED', 'CANCELLED', 'EXPIRED'] as const;

export function registerUsageRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'getUsage', async ({ ctx }) => {
    const user = await withContext(db, ctx, (trx) =>
      trx
        .selectFrom('users')
        .select(['time_zone', 'preferences'])
        .where('id', '=', ctx.userId)
        .executeTakeFirstOrThrow(),
    );
    const period = await currentMonth(db, user.time_zone);

    const { costs, tasks } = await withContext(db, ctx, async (trx) => {
      const costs = await trx
        .selectFrom('cost_records')
        .select(['category', (eb) => eb.fn.sum<number>('amount_micro').as('total')])
        .where('user_id', '=', ctx.userId)
        .where('created_at', '>=', period.start)
        .where('created_at', '<', period.end)
        .groupBy('category')
        .execute();
      const tasks = await trx
        .selectFrom('tasks')
        .select((eb) => [
          eb.fn.countAll<number>().as('total'),
          eb.fn.countAll<number>().filterWhere('status', '=', 'COMPLETED').as('completed'),
          eb.fn
            .countAll<number>()
            .filterWhere('status', 'in', [...FAILED_STATUSES])
            .as('failed'),
        ])
        .where('user_id', '=', ctx.userId)
        .where('created_at', '>=', period.start)
        .where('created_at', '<', period.end)
        .executeTakeFirstOrThrow();
      return { costs, tasks };
    });

    const byCategory = (c: string) => Number(costs.find((r) => r.category === c)?.total ?? 0);
    const totalMicroUsd = costs.reduce((sum, r) => sum + Number(r.total ?? 0), 0);
    const budgetUsd = resolvePreferences(user.preferences).spending.monthlyAiBudgetUsd;

    return {
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
      aiMicroUsd: byCategory('model'),
      toolMicroUsd: byCategory('tool'),
      totalMicroUsd,
      budgetMicroUsd: Math.round(budgetUsd * MICRO_PER_USD),
      tasks: {
        completed: Number(tasks.completed),
        failed: Number(tasks.failed),
        total: Number(tasks.total),
      },
    };
  });
}
