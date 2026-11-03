import type { FastifyInstance } from 'fastify';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import type { AppDeps } from '../../services';
import { approvalQuery, toApproval } from '../tasks/mappers';

/**
 * Safety cap for the (unpaginated) pending list. Pending approvals are bounded
 * in practice — at most one per step, and they expire — so this is never hit
 * in normal use; it only protects the endpoint from pathological data.
 */
export const PENDING_APPROVALS_CAP = 200;

export function registerApprovalRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'listApprovals', async ({ ctx }) => {
    const rows = await withContext(db, ctx, (trx) =>
      approvalQuery(trx)
        .where('a.user_id', '=', ctx.userId)
        .where('a.status', '=', 'PENDING')
        .orderBy('a.created_at', 'desc')
        .orderBy('a.id', 'desc')
        .limit(PENDING_APPROVALS_CAP)
        .execute(),
    );
    return { items: rows.map(toApproval) };
  });

  defineRoute(app, deps, 'decideApproval', async ({ ctx, params, body }) =>
    deps.agent.approvals.decide(ctx, params.id, body, ctx.platform),
  );
}
