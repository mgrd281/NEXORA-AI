import type { FastifyInstance } from 'fastify';
import type { Notification } from '@jarvis/contracts';
import { withContext } from '../../db/pool';
import type { NotificationsTable } from '../../db/types';
import { defineRoute } from '../../http/route';
import type { AppDeps } from '../../services';
import { afterCursor, cursorTimestamp, decodeCursor, toPage } from '../home/cursor';
import type { Selectable } from 'kysely';

type NotificationRow = Selectable<NotificationsTable>;

/** Localisation parameters are strings by contract; anything else is dropped or stringified. */
function toParams(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

export function toNotification(
  r: Pick<NotificationRow, 'id' | 'kind' | 'task_id' | 'data' | 'read_at' | 'created_at'>,
): Notification {
  return {
    id: r.id,
    kind: r.kind,
    taskId: r.task_id,
    data: toParams(r.data),
    readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

export function registerNotificationRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'listNotifications', async ({ ctx, query }) => {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await withContext(db, ctx, (trx) => {
      let q = trx
        .selectFrom('notifications as n')
        .select(['n.id', 'n.kind', 'n.task_id', 'n.data', 'n.read_at', 'n.created_at'])
        .select(cursorTimestamp('n.created_at').as('cursor_ts'))
        .where('n.user_id', '=', ctx.userId);
      if (cursor) q = q.where(afterCursor('n.created_at', 'n.id', cursor));
      return q
        .orderBy('n.created_at', 'desc')
        .orderBy('n.id', 'desc')
        .limit(query.limit + 1)
        .execute();
    });
    return toPage(rows, query.limit, toNotification);
  });

  defineRoute(app, deps, 'markNotificationsRead', async ({ ctx, body }) => {
    // `ids` omitted = mark everything read; an empty list marks nothing.
    if (body.ids && body.ids.length === 0) return { ok: true as const };
    await withContext(db, ctx, async (trx) => {
      let q = trx
        .updateTable('notifications')
        .set({ read_at: new Date() })
        .where('user_id', '=', ctx.userId)
        .where('read_at', 'is', null);
      if (body.ids) q = q.where('id', 'in', body.ids);
      await q.execute();
    });
    return { ok: true as const };
  });
}
