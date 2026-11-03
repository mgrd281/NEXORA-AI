/**
 * Task lifecycle operations invoked by the HTTP layer: create, cancel, retry.
 * Each runs in one RLS-scoped transaction; state changes go through the
 * shared transition helper and enqueue jobs atomically with the change.
 */
import type { CreateTaskRequest, TaskSummary } from '@jarvis/contracts';
import { sql } from 'kysely';
import { withContext, type DbContext, type Trx } from '../../db/pool';
import { AppError, invalidState, notFound } from '../../lib/errors';
import { truncate } from '../../lib/redact';
import type { TaskService } from '../../services';
import type { AgentDeps } from '../agent/index';
import { isUniqueViolation } from '../agent/errors';
import { asLocale, t } from '../agent/i18n';
import { detectLanguage } from '../agent/models/offline';
import {
  cancelOpenSteps,
  closePendingApprovals,
  lockTask,
  patchTask,
  transitionTask,
} from '../agent/task-state';
import { audit } from '../audit/audit';
import { appendEvent } from '../events/events';
import { enqueue } from '../jobs/queue';
import { taskSummaryQuery, toTaskSummary, type TaskAggregate } from './mappers';

async function summary(trx: Trx, taskId: string): Promise<TaskSummary> {
  const row = (await taskSummaryQuery(trx).where('t.id', '=', taskId).executeTakeFirst()) as
    TaskAggregate | undefined;
  if (!row) throw notFound('Task');
  return toTaskSummary(row);
}

async function byIdempotencyKey(trx: Trx, key: string): Promise<TaskSummary | null> {
  const row = (await taskSummaryQuery(trx)
    .where('t.idempotency_key', '=', key)
    .executeTakeFirst()) as TaskAggregate | undefined;
  return row ? toTaskSummary(row) : null;
}

/** Placeholder title until the planner names the task. */
export function initialTitle(request: string): string {
  return truncate(request.replace(/\s+/g, ' ').trim(), 80);
}

export function createTaskService(deps: AgentDeps): TaskService {
  const { db } = deps;

  async function create(
    ctx: DbContext,
    input: CreateTaskRequest,
    opts: { idempotencyKey?: string },
  ): Promise<TaskSummary> {
    const key = opts.idempotencyKey;
    try {
      return await withContext(db, ctx, async (trx) => {
        if (key) {
          const existing = await byIdempotencyKey(trx, key);
          if (existing) return existing;
        }
        const user = await trx
          .selectFrom('users')
          .select('locale')
          .where('id', '=', ctx.userId)
          .executeTakeFirstOrThrow();
        const language = input.language ?? detectLanguage(input.request, asLocale(user.locale));
        const title = initialTitle(input.request);
        const conversation = await trx
          .insertInto('conversations')
          .values({ tenant_id: ctx.tenantId, user_id: ctx.userId, title })
          .returning('id')
          .executeTakeFirstOrThrow();
        const task = await trx
          .insertInto('tasks')
          .values({
            tenant_id: ctx.tenantId,
            user_id: ctx.userId,
            conversation_id: conversation.id,
            title,
            request: input.request,
            source: input.source,
            language,
            idempotency_key: key ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('messages')
          .values({
            tenant_id: ctx.tenantId,
            user_id: ctx.userId,
            conversation_id: conversation.id,
            task_id: task.id,
            role: 'user',
            content: input.request,
            language,
          })
          .execute();
        if (input.voiceSessionId) {
          await trx
            .updateTable('voice_sessions')
            .set({ task_id: task.id })
            .where('id', '=', input.voiceSessionId)
            .where('task_id', 'is', null)
            .execute();
        }
        await appendEvent(trx, ctx, {
          taskId: task.id,
          type: 'task.created',
          data: { status: 'QUEUED' },
        });
        await enqueue(trx, {
          kind: 'task.plan',
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          taskId: task.id,
          dedupeKey: `plan:${task.id}`,
        });
        await audit(trx, {
          tenantId: ctx.tenantId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'task.created',
          targetType: 'task',
          targetId: task.id,
          metadata: { source: input.source, language, requestChars: input.request.length },
        });
        return summary(trx, task.id);
      });
    } catch (err) {
      // A concurrent request with the same key won the race: replay its task.
      if (key && isUniqueViolation(err)) {
        const replay = await withContext(db, ctx, (trx) => byIdempotencyKey(trx, key));
        if (replay) return replay;
      }
      throw err;
    }
  }

  async function cancel(ctx: DbContext, taskId: string): Promise<TaskSummary> {
    return withContext(db, ctx, async (trx) => {
      const task = await lockTask(trx, taskId);
      const language = asLocale(task.language);
      switch (task.status) {
        case 'QUEUED':
        case 'AWAITING_APPROVAL': {
          await closePendingApprovals(trx, task.id);
          await cancelOpenSteps(trx, task.id);
          await transitionTask(trx, ctx, task, 'CANCELLED', {
            cancel_requested_at: new Date(),
            result_summary: t(language, 'result.cancelled'),
          });
          await audit(trx, {
            tenantId: ctx.tenantId,
            actorType: 'user',
            actorId: ctx.userId,
            action: 'task.cancelled',
            targetType: 'task',
            targetId: task.id,
            metadata: { from: task.status },
          });
          break;
        }
        case 'PLANNING':
        case 'RUNNING': {
          if (!task.cancel_requested_at) {
            await patchTask(trx, task, { cancel_requested_at: new Date() });
            await appendEvent(trx, ctx, {
              taskId: task.id,
              type: 'task.cancel_requested',
              data: {},
            });
            await audit(trx, {
              tenantId: ctx.tenantId,
              actorType: 'user',
              actorId: ctx.userId,
              action: 'task.cancel_requested',
              targetType: 'task',
              targetId: task.id,
              metadata: { from: task.status },
            });
          }
          break;
        }
        default:
          throw invalidState(
            task.status === 'VERIFYING'
              ? 'This task is finishing and can no longer be cancelled.'
              : 'This task has already finished.',
          );
      }
      return summary(trx, task.id);
    });
  }

  async function retry(
    ctx: DbContext,
    taskId: string,
    opts: { acknowledgeUnknownOutcome: boolean },
  ): Promise<TaskSummary> {
    return withContext(db, ctx, async (trx) => {
      const task = await lockTask(trx, taskId);
      if (task.status !== 'FAILED' && task.status !== 'EXPIRED')
        throw invalidState('Only failed or expired tasks can be retried.');
      const unknownOutcome = task.error?.code === 'OUTCOME_UNKNOWN';
      if (unknownOutcome && !opts.acknowledgeUnknownOutcome) {
        throw new AppError(
          'INVALID_STATE',
          'The last attempt may already have completed its action (for example, sent the email). Check first, then confirm the retry to allow JARVIS to run it again.',
          { requiresAcknowledgement: true },
        );
      }
      if (unknownOutcome) {
        // The user accepted the risk of a duplicate: free the idempotency keys of
        // executions with an unknown outcome (the rows stay as history).
        await trx
          .updateTable('tool_executions')
          .set({
            idempotency_key: sql<string>`idempotency_key || ':acknowledged:' || id::text`,
          })
          .where('task_id', '=', task.id)
          .where('status', '=', 'unknown')
          .execute();
      }
      await trx
        .updateTable('task_steps')
        .set({ status: 'PENDING', error: null, started_at: null, completed_at: null })
        .where('task_id', '=', task.id)
        .where('status', 'not in', ['SUCCEEDED', 'SKIPPED'])
        .execute();
      const attempt = task.attempt + 1;
      await transitionTask(trx, ctx, task, 'QUEUED', {
        attempt,
        error: null,
        result_summary: null,
        cancel_requested_at: null,
        completed_at: null,
      });
      await appendEvent(trx, ctx, { taskId: task.id, type: 'task.retried', data: { attempt } });
      await enqueue(trx, {
        kind: 'task.plan',
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        taskId: task.id,
        dedupeKey: `plan:${task.id}`,
      });
      await audit(trx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'task.retried',
        targetType: 'task',
        targetId: task.id,
        metadata: { attempt, acknowledgedUnknownOutcome: unknownOutcome },
      });
      return summary(trx, task.id);
    });
  }

  return { create, cancel, retry };
}
