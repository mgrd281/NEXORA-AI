/** Conversations HTTP surface (docs/architecture/phase-b.md §3.1). */
import type { FastifyInstance } from 'fastify';
import { ACTIVE_STATUSES } from '@jarvis/contracts';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { AppError, notFound } from '../../lib/errors';
import type { AppDeps } from '../../services';
import { deleteObjectsNow } from '../attachments/routes';
import { audit } from '../audit/audit';
import { appendEvent } from '../events/events';
import { listConversations, loadConversation } from './read';

export function registerConversationRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'listConversations', async ({ ctx, query }) =>
    withContext(db, ctx, (trx) => listConversations(trx, ctx.userId, query)),
  );

  defineRoute(app, deps, 'getConversation', async ({ ctx, params, query }) => {
    const detail = await withContext(db, ctx, (trx) => loadConversation(trx, params.id, query));
    if (!detail) throw notFound('Conversation');
    return detail;
  });

  // The runtime owns intake: busy check, task + message, attachments, planning job.
  defineRoute(app, deps, 'followUp', async ({ ctx, params, body, idempotencyKey }) =>
    deps.agent.tasks.followUp(ctx, params.id, body, { idempotencyKey }),
  );

  defineRoute(app, deps, 'deleteConversation', async ({ ctx, params, req }) => {
    const objects = await withContext(db, ctx, async (trx) => {
      // Locked so a follow-up cannot start while it is being deleted.
      const conv = await trx
        .selectFrom('conversations')
        .select('id')
        .where('id', '=', params.id)
        .forUpdate()
        .executeTakeFirst();
      if (!conv) throw notFound('Conversation');
      const active = await trx
        .selectFrom('tasks')
        .select('id')
        .where('conversation_id', '=', params.id)
        .where('status', 'in', [...ACTIVE_STATUSES])
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (active) {
        throw new AppError('INVALID_STATE', 'Finish or cancel the running task first', {
          reason: 'CONVERSATION_ACTIVE_TASK',
          taskId: active.id,
        });
      }
      const files = await trx
        .selectFrom('attachments')
        .select(['storage_key', 'storage_driver'])
        .where('conversation_id', '=', params.id)
        .execute();
      const { n } = await trx
        .selectFrom('tasks')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('conversation_id', '=', params.id)
        .executeTakeFirstOrThrow();
      // Cascades: tasks (steps, approvals, events…), messages, attachments (→ storage
      // deletions via trigger). A schedule pointing here starts a new conversation next run.
      await trx.deleteFrom('conversations').where('id', '=', params.id).execute();
      await appendEvent(trx, ctx, {
        taskId: null,
        type: 'conversation.changed',
        data: { conversationId: params.id, change: 'deleted' },
      });
      await audit(trx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'conversation.deleted',
        targetType: 'conversation',
        targetId: params.id,
        metadata: { tasks: Number(n), attachments: files.length },
      });
      return files;
    });
    await deleteObjectsNow(deps, objects, req.log);
  });
}
