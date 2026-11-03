import type { FastifyInstance } from 'fastify';
import { ACTIVE_STATUSES, type TaskListQuery, type TaskStatus } from '@jarvis/contracts';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { notFound } from '../../lib/errors';
import type { AppDeps } from '../../services';
import { afterCursor, cursorTimestamp, decodeCursor, toPage } from '../home/cursor';
import { loadTaskDetail, taskSummaryQuery, toTaskSummary, type TaskAggregate } from './mappers';

/** Statuses behind each task-list filter ('all' applies no filter). */
export const TASK_STATUS_FILTERS: Record<
  Exclude<TaskListQuery['status'], 'all'>,
  readonly TaskStatus[]
> = {
  active: ACTIVE_STATUSES,
  needs_approval: ['AWAITING_APPROVAL'],
  completed: ['COMPLETED'],
  failed: ['FAILED', 'CANCELLED', 'EXPIRED'],
};

export function registerTaskRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'listTasks', async ({ ctx, query }) => {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await withContext(db, ctx, (trx) => {
      let q = taskSummaryQuery(trx)
        .select(cursorTimestamp('t.created_at').as('cursor_ts'))
        .where('t.user_id', '=', ctx.userId);
      if (query.status !== 'all')
        q = q.where('t.status', 'in', [...TASK_STATUS_FILTERS[query.status]]);
      if (cursor) q = q.where(afterCursor('t.created_at', 't.id', cursor));
      return q
        .orderBy('t.created_at', 'desc')
        .orderBy('t.id', 'desc')
        .limit(query.limit + 1)
        .execute();
    });
    return toPage(rows, query.limit, (r) => toTaskSummary(r as TaskAggregate));
  });

  defineRoute(app, deps, 'getTask', async ({ ctx, params }) => {
    const detail = await withContext(db, ctx, (trx) => loadTaskDetail(trx, params.id));
    if (!detail) throw notFound('Task');
    return detail;
  });

  defineRoute(app, deps, 'createTask', async ({ ctx, body, idempotencyKey }) =>
    deps.agent.tasks.create(ctx, body, { idempotencyKey }),
  );

  defineRoute(app, deps, 'cancelTask', async ({ ctx, params }) =>
    deps.agent.tasks.cancel(ctx, params.id),
  );

  defineRoute(app, deps, 'retryTask', async ({ ctx, params, body }) =>
    deps.agent.tasks.retry(ctx, params.id, {
      acknowledgeUnknownOutcome: body.acknowledgeUnknownOutcome,
    }),
  );
}
