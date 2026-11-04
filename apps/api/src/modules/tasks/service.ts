/**
 * Task lifecycle operations invoked by the HTTP layer: create, follow-up,
 * cancel, retry — and createScheduledTask for the scheduler. Each runs in one
 * RLS-scoped transaction; state changes go through the shared transition
 * helper and enqueue jobs atomically with the change.
 *
 * Phase B (docs/architecture/phase-b.md §3.1, §3.3, §3.5): every new task
 * belongs to a conversation (a new one for create, the caller's for a
 * follow-up, the schedule's for a run), links the files its request names,
 * writes the user's message, and emits conversation.message and the
 * task.created webhook in the same transaction.
 */
import {
  ACTIVE_STATUSES,
  ATTACHMENT_LIMITS,
  canRetryTask,
  type CreateTaskRequest,
  type ErrorCode,
  type FollowUpRequest,
  type Locale,
  type TaskSource,
  type TaskSummary,
} from '@jarvis/contracts';
import { sql } from 'kysely';
import { withContext, type DbContext, type Trx } from '../../db/pool';
import type { ScheduleRow } from '../../db/types';
import { AppError, invalidState, notFound } from '../../lib/errors';
import { truncate } from '../../lib/redact';
import type { TaskService } from '../../services';
import { loadAgentContext } from '../agent/context';
import type { AgentDeps } from '../agent/index';
import { isUniqueViolation } from '../agent/errors';
import { asLocale } from '../agent/i18n';
import { cancelledResult } from '../agent/plan-job';
import { detectLanguage } from '../agent/models/offline';
import {
  cancelOpenSteps,
  closePendingApprovals,
  lockTask,
  patchTask,
  transitionTask,
} from '../agent/task-state';
import { emitScheduleWebhook, emitTaskWebhook } from '../agent/webhook-events';
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

const attachmentError = (
  reason:
    | 'ATTACHMENT_NOT_FOUND'
    | 'ATTACHMENT_EXPIRED'
    | 'ATTACHMENT_IN_OTHER_CONVERSATION'
    | 'TOO_MANY_ATTACHMENTS',
  message: string,
  extra: Record<string, unknown> = {},
) => new AppError('VALIDATION_FAILED', message, { reason, ...extra });

/**
 * Links the files a request names to its task (positions in request order)
 * and moves unattached uploads into the task's conversation. Each file must
 * be the caller's (RLS), unexpired while unattached, and either unattached or
 * already in this conversation. Rows are locked in id order (no deadlock with
 * a concurrent request naming the same files).
 */
async function linkAttachments(
  trx: Trx,
  ctx: DbContext,
  taskId: string,
  conversationId: string,
  ids: readonly string[],
): Promise<number> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return 0;
  if (unique.length > ATTACHMENT_LIMITS.maxPerRequest)
    throw attachmentError('TOO_MANY_ATTACHMENTS', 'Too many attachments for one request.', {
      max: ATTACHMENT_LIMITS.maxPerRequest,
    });
  const rows = await trx
    .selectFrom('attachments')
    .select(['id', 'conversation_id', 'expires_at'])
    .where('id', 'in', unique)
    .orderBy('id')
    .forUpdate()
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const now = Date.now();
  for (const id of unique) {
    const row = byId.get(id);
    if (!row) throw attachmentError('ATTACHMENT_NOT_FOUND', 'Attachment not found.', { id });
    if (row.conversation_id === null) {
      if (row.expires_at && new Date(row.expires_at).getTime() <= now)
        throw attachmentError('ATTACHMENT_EXPIRED', 'This upload has expired; upload it again.', {
          id,
        });
    } else if (row.conversation_id !== conversationId) {
      throw attachmentError(
        'ATTACHMENT_IN_OTHER_CONVERSATION',
        'This file belongs to another conversation.',
        { id },
      );
    }
  }
  await trx
    .updateTable('attachments')
    .set({ conversation_id: conversationId, expires_at: null })
    .where('id', 'in', unique)
    .where('conversation_id', 'is', null)
    .execute();
  await trx
    .insertInto('task_attachments')
    .values(
      unique.map((attachmentId, position) => ({
        task_id: taskId,
        attachment_id: attachmentId,
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        position,
      })),
    )
    .execute();
  return unique.length;
}

interface IntakeInput {
  conversationId: string;
  request: string;
  source: TaskSource;
  language: Locale;
  idempotencyKey: string | null;
  voiceSessionId?: string;
  attachmentIds?: readonly string[];
  scheduleId?: string | null;
}

/**
 * The shared part of every intake: task (QUEUED), the user's message, file
 * links, voice session link, conversation activity, events, the plan job and
 * the task.created webhook. Returns the task id and how many files it links.
 */
async function insertTask(
  trx: Trx,
  ctx: DbContext,
  i: IntakeInput,
): Promise<{ taskId: string; attachments: number }> {
  const title = initialTitle(i.request);
  const task = await trx
    .insertInto('tasks')
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      conversation_id: i.conversationId,
      title,
      request: i.request,
      source: i.source,
      language: i.language,
      idempotency_key: i.idempotencyKey,
      schedule_id: i.scheduleId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const message = await trx
    .insertInto('messages')
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      conversation_id: i.conversationId,
      task_id: task.id,
      role: 'user',
      kind: 'request',
      content: i.request,
      language: i.language,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const attachments = await linkAttachments(
    trx,
    ctx,
    task.id,
    i.conversationId,
    i.attachmentIds ?? [],
  );
  if (i.voiceSessionId) {
    await trx
      .updateTable('voice_sessions')
      .set({ task_id: task.id })
      .where('id', '=', i.voiceSessionId)
      .where('task_id', 'is', null)
      .execute();
  }
  await trx
    .updateTable('conversations')
    .set({ updated_at: new Date() })
    .where('id', '=', i.conversationId)
    .execute();
  await appendEvent(trx, ctx, {
    taskId: task.id,
    type: 'task.created',
    data: { status: 'QUEUED' },
  });
  await appendEvent(trx, ctx, {
    taskId: task.id,
    type: 'conversation.message',
    data: {
      conversationId: i.conversationId,
      messageId: message.id,
      taskId: task.id,
      role: 'user',
      kind: 'request',
    },
  });
  await enqueue(trx, {
    kind: 'task.plan',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    taskId: task.id,
    dedupeKey: `plan:${task.id}`,
  });
  await emitTaskWebhook(trx, ctx, 'task.created', task);
  return { taskId: task.id, attachments };
}

async function requestLanguage(
  trx: Trx,
  ctx: DbContext,
  request: string,
  given: Locale | null | undefined,
): Promise<Locale> {
  if (given) return given;
  const user = await trx
    .selectFrom('users')
    .select('locale')
    .where('id', '=', ctx.userId)
    .executeTakeFirstOrThrow();
  return detectLanguage(request, asLocale(user.locale));
}

/**
 * The task of one schedule occurrence (schedule.run job, inside its
 * transaction): in the schedule's conversation (created with the schedule's
 * title on first use and stored on the schedule), source 'schedule',
 * idempotency key schedule:<id>:<occurrence>, planned like any task. Emits
 * schedule.triggered. Idempotent: an existing task for the occurrence is returned.
 */
export async function createScheduledTask(
  trx: Trx,
  ctx: DbContext,
  schedule: ScheduleRow,
  occurrenceAt: Date,
): Promise<{ taskId: string }> {
  const key = `schedule:${schedule.id}:${occurrenceAt.toISOString()}`;
  const existing = await trx
    .selectFrom('tasks')
    .select('id')
    .where('idempotency_key', '=', key)
    .executeTakeFirst();
  if (existing) return { taskId: existing.id };
  let conversationId = schedule.conversation_id;
  if (conversationId) {
    const found = await trx
      .selectFrom('conversations')
      .select('id')
      .where('id', '=', conversationId)
      .executeTakeFirst();
    if (!found) conversationId = null;
  }
  if (!conversationId) {
    const conversation = await trx
      .insertInto('conversations')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        title: truncate(schedule.title, 120),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    conversationId = conversation.id;
    await trx
      .updateTable('scheduled_tasks')
      .set({ conversation_id: conversationId })
      .where('id', '=', schedule.id)
      .execute();
  }
  const language = await requestLanguage(trx, ctx, schedule.request, schedule.language);
  const { taskId } = await insertTask(trx, ctx, {
    conversationId,
    request: schedule.request,
    source: 'schedule',
    language,
    idempotencyKey: key,
    scheduleId: schedule.id,
  });
  await audit(trx, {
    tenantId: ctx.tenantId,
    actorType: 'system',
    actorId: null,
    action: 'task.created',
    targetType: 'task',
    targetId: taskId,
    metadata: {
      source: 'schedule',
      scheduleId: schedule.id,
      occurrenceAt: occurrenceAt.toISOString(),
      language,
      requestChars: schedule.request.length,
    },
  });
  await emitScheduleWebhook(trx, ctx, 'schedule.triggered', schedule, {
    occurrenceAt,
    taskId,
    reason: null,
  });
  return { taskId };
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
        const language = await requestLanguage(trx, ctx, input.request, input.language);
        const conversation = await trx
          .insertInto('conversations')
          .values({
            tenant_id: ctx.tenantId,
            user_id: ctx.userId,
            title: initialTitle(input.request),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const { taskId, attachments } = await insertTask(trx, ctx, {
          conversationId: conversation.id,
          request: input.request,
          source: input.source,
          language,
          idempotencyKey: key ?? null,
          voiceSessionId: input.voiceSessionId,
          attachmentIds: input.attachmentIds,
        });
        await audit(trx, {
          tenantId: ctx.tenantId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'task.created',
          targetType: 'task',
          targetId: taskId,
          metadata: {
            source: input.source,
            language,
            requestChars: input.request.length,
            ...(attachments ? { attachments } : {}),
          },
        });
        return summary(trx, taskId);
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

  async function followUp(
    ctx: DbContext,
    conversationId: string,
    input: FollowUpRequest,
    opts: { idempotencyKey?: string },
  ): Promise<TaskSummary> {
    const key = opts.idempotencyKey;
    try {
      return await withContext(db, ctx, async (trx) => {
        if (key) {
          const existing = await byIdempotencyKey(trx, key);
          if (existing) return existing;
        }
        // Concurrent follow-ups of one conversation serialise on its row.
        const conversation = await trx
          .selectFrom('conversations')
          .select('id')
          .where('id', '=', conversationId)
          .forUpdate()
          .executeTakeFirst();
        if (!conversation) throw notFound('Conversation');
        const active = await trx
          .selectFrom('tasks')
          .select('id')
          .where('conversation_id', '=', conversationId)
          .where('status', 'in', ACTIVE_STATUSES)
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirst();
        if (active) {
          throw new AppError(
            'INVALID_STATE',
            'A task in this conversation is still in progress. Wait for it, decide its approval or cancel it first.',
            { reason: 'CONVERSATION_BUSY', taskId: active.id },
          );
        }
        const language = await requestLanguage(trx, ctx, input.request, input.language);
        const { taskId, attachments } = await insertTask(trx, ctx, {
          conversationId,
          request: input.request,
          source: input.source,
          language,
          idempotencyKey: key ?? null,
          voiceSessionId: input.voiceSessionId,
          attachmentIds: input.attachmentIds,
        });
        await audit(trx, {
          tenantId: ctx.tenantId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'task.created',
          targetType: 'task',
          targetId: taskId,
          metadata: {
            source: input.source,
            language,
            requestChars: input.request.length,
            followUp: true,
            attachments,
          },
        });
        return summary(trx, taskId);
      });
    } catch (err) {
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
      switch (task.status) {
        case 'QUEUED':
        case 'AWAITING_APPROVAL': {
          await closePendingApprovals(trx, task.id);
          await cancelOpenSteps(trx, task.id);
          await transitionTask(trx, ctx, task, 'CANCELLED', {
            cancel_requested_at: new Date(),
            ...cancelledResult(task.language),
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
      // Same rule as TaskDetail.canRetry: a retry that can only fail the same way is refused.
      const agent = await loadAgentContext(trx, deps.config, ctx.userId);
      const error = task.error
        ? { code: task.error.code as ErrorCode, retryable: !!task.error.retryable }
        : null;
      if (
        !canRetryTask(
          { status: task.status, error },
          { modelAvailable: agent.route.mode === 'model' },
        )
      ) {
        throw new AppError(
          'INVALID_STATE',
          'Retrying would fail the same way. Change the request and ask again.',
          { notRetryable: true, errorCode: error?.code ?? null },
        );
      }
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
      // Everything that did not succeed runs again, including steps SKIPPED because
      // the task failed before reaching them (failTask).
      await trx
        .updateTable('task_steps')
        .set({ status: 'PENDING', error: null, started_at: null, completed_at: null })
        .where('task_id', '=', task.id)
        .where('status', '<>', 'SUCCEEDED')
        .execute();
      const attempt = task.attempt + 1;
      await transitionTask(trx, ctx, task, 'QUEUED', {
        attempt,
        error: null,
        result_summary: null,
        result_summary_message: null,
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

  return { create, followUp, cancel, retry };
}
