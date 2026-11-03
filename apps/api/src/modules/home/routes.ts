import type { FastifyInstance } from 'fastify';
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from '@jarvis/contracts';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import type { AppDeps } from '../../services';
import { resolvePreferences } from '../account/me';
import {
  approvalQuery,
  taskSummaryQuery,
  toApproval,
  toTaskSummary,
  type TaskAggregate,
} from '../tasks/mappers';
import { deriveSuggestions } from './suggestions';

/** Items per home section. */
export const HOME_SECTION_LIMIT = 5;

export function registerHomeRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'getHome', async ({ ctx }) => {
    const [assistant, snapshot] = await Promise.all([
      deps.agent.status.get(ctx),
      withContext(db, ctx, async (trx) => {
        const pendingApprovals = await approvalQuery(trx)
          .where('a.user_id', '=', ctx.userId)
          .where('a.status', '=', 'PENDING')
          .orderBy('a.created_at', 'desc')
          .orderBy('a.id', 'desc')
          .limit(HOME_SECTION_LIMIT)
          .execute();
        const activeTasks = await taskSummaryQuery(trx)
          .where('t.user_id', '=', ctx.userId)
          .where('t.status', 'in', [...ACTIVE_STATUSES])
          .orderBy('t.updated_at', 'desc')
          .orderBy('t.id', 'desc')
          .limit(HOME_SECTION_LIMIT)
          .execute();
        const recentTasks = await taskSummaryQuery(trx)
          .where('t.user_id', '=', ctx.userId)
          .where('t.status', 'in', [...TERMINAL_STATUSES])
          .orderBy('t.updated_at', 'desc')
          .orderBy('t.id', 'desc')
          .limit(HOME_SECTION_LIMIT)
          .execute();
        const unread = await trx
          .selectFrom('notifications')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('user_id', '=', ctx.userId)
          .where('read_at', 'is', null)
          .executeTakeFirstOrThrow();
        const connections = await trx
          .selectFrom('connections')
          .select(['provider', 'status'])
          .where('user_id', '=', ctx.userId)
          .where('status', '<>', 'revoked')
          .execute();
        const memory = await trx
          .selectFrom('memories')
          .select('id')
          .where('user_id', '=', ctx.userId)
          .limit(1)
          .executeTakeFirst();
        const user = await trx
          .selectFrom('users')
          .select('preferences')
          .where('id', '=', ctx.userId)
          .executeTakeFirst();
        const isActive = (provider: 'web' | 'smtp') =>
          connections.some((c) => c.provider === provider && c.status === 'active');
        return {
          pendingApprovals: pendingApprovals.map(toApproval),
          activeTasks: activeTasks.map((t) => toTaskSummary(t as TaskAggregate)),
          recentTasks: recentTasks.map((t) => toTaskSummary(t as TaskAggregate)),
          unreadNotifications: Number(unread.n),
          webActive: isActive('web'),
          emailActive: isActive('smtp'),
          hasMemories: !!memory,
          memoryEnabled: resolvePreferences(user?.preferences).memory.enabled,
        };
      }),
    ]);

    return {
      assistant,
      pendingApprovals: snapshot.pendingApprovals,
      activeTasks: snapshot.activeTasks,
      recentTasks: snapshot.recentTasks,
      unreadNotifications: snapshot.unreadNotifications,
      suggestions: deriveSuggestions({
        webActive: snapshot.webActive,
        emailActive: snapshot.emailActive,
        plannerOffline: assistant.planner.mode === 'offline',
        memoryEnabled: snapshot.memoryEnabled,
        hasMemories: snapshot.hasMemories,
      }),
    };
  });

  defineRoute(app, deps, 'getAssistantStatus', async ({ ctx }) => deps.agent.status.get(ctx));
}
