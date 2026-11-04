import type { FastifyInstance } from 'fastify';
import { ACTIVE_STATUSES, CALENDAR_LIMITS, TERMINAL_STATUSES } from '@jarvis/contracts';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import type { AppDeps } from '../../services';
import { resolvePreferences } from '../account/me';
import { integrations } from '../integrations';
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

  defineRoute(app, deps, 'getHome', async ({ ctx, reply }) => {
    const [assistant, upcoming, snapshot] = await Promise.all([
      deps.agent.status.get(ctx),
      // Phase C "Upcoming" (spec §4A): null — the section is not shown — unless a connection
      // grants calendar.read. Each calendar answers within homeTimeoutMs or is reported as
      // 'unavailable' in `sources`: Home never waits on, or fails because of, a slow provider.
      integrations.upcomingEvents(deps, ctx, { timeoutMs: CALENDAR_LIMITS.homeTimeoutMs }),
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
          .select(['provider', 'status', 'capabilities'])
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
        // Phase C: an active Google / Microsoft account granting mail.send sends email too.
        const providerMail = connections.some(
          (c) =>
            (c.provider === 'google' || c.provider === 'microsoft') &&
            c.status === 'active' &&
            c.capabilities.includes('mail.send'),
        );
        return {
          pendingApprovals: pendingApprovals.map(toApproval),
          activeTasks: activeTasks.map((t) => toTaskSummary(t as TaskAggregate)),
          recentTasks: recentTasks.map((t) => toTaskSummary(t as TaskAggregate)),
          unreadNotifications: Number(unread.n),
          webActive: isActive('web'),
          emailActive: isActive('smtp') || providerMail,
          hasMemories: !!memory,
          memoryEnabled: resolvePreferences(user?.preferences).memory.enabled,
        };
      }),
    ]);

    // Calendar entries of other people (invitations): never kept by shared caches.
    reply.header('cache-control', 'private, no-store');
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
      upcoming,
    };
  });

  defineRoute(app, deps, 'getAssistantStatus', async ({ ctx }) => deps.agent.status.get(ctx));
}
