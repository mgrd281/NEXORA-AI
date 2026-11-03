import type { FastifyInstance } from 'fastify';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import type { AppDeps } from '../../services';
import { currentMonth } from '../../lib/period';
import { resolvePreferences } from '../account/me';

const MICRO_PER_USD = 1_000_000;

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
