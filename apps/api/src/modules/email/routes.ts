/**
 * Email reply tracking (docs/architecture/phase-c.md §3.2): the threads
 * email.track_replies watches. Rows hold a subject and a sender only (no mail
 * content). Stopping keeps the row as 'stopped' (the history the user sees);
 * the integrations module owns the state change and its event.
 */
import type { FastifyInstance } from 'fastify';
import { EMAIL_LIMITS } from '@jarvis/contracts';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { notFound } from '../../lib/errors';
import type { AppDeps } from '../../services';
import { audit } from '../audit/audit';
import { integrations, toEmailWatch } from '../integrations';

/**
 * Watches listed at most. Live watches are capped per user
 * (EMAIL_LIMITS.watchMaxPerUser) and always listed first, so the cap only
 * shortens the history of ended ones.
 */
export const WATCH_LIST_MAX = 100;

export function registerEmailRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'listEmailWatches', async ({ ctx }) => {
    const rows = await withContext(db, ctx, (trx) =>
      trx
        .selectFrom('email_watches')
        .selectAll()
        .where('user_id', '=', ctx.userId)
        .orderBy((eb) => eb.case().when('status', '=', 'watching').then(0).else(1).end())
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(Math.max(WATCH_LIST_MAX, EMAIL_LIMITS.watchMaxPerUser))
        .execute(),
    );
    return { items: rows.map(toEmailWatch) };
  });

  defineRoute(app, deps, 'deleteEmailWatch', async ({ ctx, params }) => {
    await withContext(db, ctx, async (trx) => {
      // Idempotent: an ended watch stays as it is (replied / expired / stopped / failed).
      const row = await integrations.stopWatch(trx, ctx, params.id);
      if (!row) throw notFound('Watch');
      await audit(trx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'email_watch.stopped',
        targetType: 'email_watch',
        targetId: row.id,
        metadata: { provider: row.provider, status: row.status },
      });
    });
  });
}
