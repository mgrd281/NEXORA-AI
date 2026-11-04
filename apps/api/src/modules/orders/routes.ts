/**
 * Orders JARVIS placed or tried to place (docs/architecture/phase-c.md §3.6,
 * §3.8): read-only records written by the commerce module (exactly once per
 * step). Keyset pages ordered (created_at DESC, id DESC); every lookup is
 * RLS-scoped, so another user's order is a 404.
 */
import type { FastifyInstance } from 'fastify';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { notFound } from '../../lib/errors';
import type { AppDeps } from '../../services';
import { loadEvidenceByIds, pickEvidence } from '../evidence/mappers';
import { afterCursor, cursorTimestamp, decodeCursor, toPage } from '../home/cursor';
import { ORDER_COLUMNS, orderEvidenceIds, toOrder } from './mappers';

export function registerOrderRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'listOrders', async ({ ctx, query }) => {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    return withContext(db, ctx, async (trx) => {
      let b = trx
        .selectFrom('orders as o')
        .select(ORDER_COLUMNS.map((c) => `o.${c}` as const))
        .select(cursorTimestamp('o.created_at').as('cursor_ts'))
        .where('o.user_id', '=', ctx.userId);
      if (query.status) b = b.where('o.status', '=', query.status);
      if (cursor) b = b.where(afterCursor('o.created_at', 'o.id', cursor));
      const rows = await b
        .orderBy('o.created_at', 'desc')
        .orderBy('o.id', 'desc')
        .limit(query.limit + 1)
        .execute();
      const evidence = await loadEvidenceByIds(
        trx,
        rows.slice(0, query.limit).flatMap(orderEvidenceIds),
      );
      return toPage(rows, query.limit, (r) =>
        toOrder(r, pickEvidence(evidence, orderEvidenceIds(r))),
      );
    });
  });

  defineRoute(app, deps, 'getOrder', async ({ ctx, params }) => {
    const order = await withContext(db, ctx, async (trx) => {
      const row = await trx
        .selectFrom('orders')
        .select(ORDER_COLUMNS)
        .where('id', '=', params.id)
        .executeTakeFirst();
      if (!row) return null;
      const evidence = await loadEvidenceByIds(trx, orderEvidenceIds(row));
      return toOrder(row, pickEvidence(evidence, orderEvidenceIds(row)));
    });
    if (!order) throw notFound('Order');
    return order;
  });
}
