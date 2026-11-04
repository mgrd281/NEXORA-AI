/**
 * task.plan job: QUEUED → PLANNING → (plan, policy check) → RUNNING + task.execute.
 *
 * Three short transactions; no transaction is held across the model call.
 * On retry (the task already has steps) the model is skipped and only the
 * policies of unfinished steps are re-checked.
 */
import type { AttachmentMediaType, Locale, PlannerInfo, RiskLevel } from '@jarvis/contracts';
import { withContext, type DbContext, type Trx } from '../../db/pool';
import type { AttachmentRow, JobRow, StepRow, TaskRow } from '../../db/types';
import { audit } from '../audit/audit';
import { appendEvent } from '../events/events';
import { enqueue, workerHealth } from '../jobs/queue';
import { initialTitle } from '../tasks/service';
import { loadAgentContext, relevantMemories, type AgentContext } from './context';
import { loadConversationContext, type PriorTurn } from './conversation-context';
import { AgentError } from './errors';
import { asLocale, msg, render } from './i18n';
import type { PlanningAttachment } from './models/offline';
import { costMicro } from './models/pricing';
import { selectModel } from './models/router';
import { planTask, type PlanOutcome } from './planner';
import type { Plan } from './plan';
import { checkLease, type RuntimeDeps } from './runtime';
import { stepRef } from './events-data';
import { assessStep, denyError, maxRisk } from './step-policy';
import {
  cancelOpenSteps,
  closePendingApprovals,
  failTask,
  lockTask,
  patchTask,
  recordUsage,
  taskErrorJson,
  transitionTask,
  tryLockTask,
} from './task-state';
import { availableTools, getTool } from './tools/registry';

export type JobOutcome = 'done' | 'awaiting_approval';

const FINISHED_STEP = new Set(['SUCCEEDED', 'SKIPPED']);

/**
 * Files of a task's conversation (RLS), the ones its own request named first
 * (in their order), then earlier ones, newest first.
 */
export async function conversationAttachments(
  trx: Trx,
  task: Pick<TaskRow, 'id' | 'conversation_id'>,
): Promise<{ rows: AttachmentRow[]; planning: PlanningAttachment[] }> {
  const [rows, links] = await Promise.all([
    trx
      .selectFrom('attachments')
      .selectAll()
      .where('conversation_id', '=', task.conversation_id)
      .orderBy('created_at', 'desc')
      .execute(),
    trx
      .selectFrom('task_attachments')
      .select(['attachment_id', 'position'])
      .where('task_id', '=', task.id)
      .execute(),
  ]);
  const position = new Map(links.map((l) => [l.attachment_id, l.position]));
  const ordered = [
    ...rows
      .filter((r) => position.has(r.id))
      .sort((a, b) => position.get(a.id)! - position.get(b.id)!),
    ...rows.filter((r) => !position.has(r.id)),
  ];
  return {
    rows: ordered,
    planning: ordered.map((r) => ({
      id: r.id,
      filename: r.filename,
      mediaType: r.media_type as AttachmentMediaType,
      sizeBytes: r.size_bytes,
      pageCount: r.page_count,
      attachedToRequest: position.has(r.id),
    })),
  };
}

/** The cost-estimate view of the conversation's files (document.analyze sizes by them). */
export const costAttachments = (rows: readonly AttachmentRow[]) =>
  rows.map((r) => ({ id: r.id, sizeBytes: r.size_bytes, textChars: r.text_chars }));

/**
 * After the first task of a conversation is planned, the conversation takes
 * the plan's title (only while it still has the placeholder from intake).
 */
async function titleConversation(
  trx: Trx,
  ctx: DbContext,
  task: TaskRow,
  plan: Plan,
): Promise<void> {
  const conversation = await trx
    .selectFrom('conversations')
    .select(['id', 'title', 'title_message'])
    .where('id', '=', task.conversation_id)
    .forUpdate()
    .executeTakeFirst();
  if (!conversation || conversation.title_message) return;
  if (conversation.title !== initialTitle(task.request)) return;
  const earlier = await trx
    .selectFrom('tasks')
    .select('id')
    .where('conversation_id', '=', task.conversation_id)
    .where('id', '<>', task.id)
    .where('created_at', '<=', task.created_at)
    .limit(1)
    .executeTakeFirst();
  if (earlier) return;
  await trx
    .updateTable('conversations')
    .set({
      title: plan.title,
      title_message: plan.titleMessage ? JSON.stringify(plan.titleMessage) : null,
      updated_at: new Date(),
    })
    .where('id', '=', conversation.id)
    .execute();
  await appendEvent(trx, ctx, {
    taskId: task.id,
    type: 'conversation.changed',
    data: { conversationId: conversation.id, change: 'title' },
  });
}

/** result_summary + result_summary_message of a cancelled task. */
export function cancelledResult(language: string | null) {
  const m = msg('result.cancelled');
  return {
    result_summary: render(asLocale(language), m),
    result_summary_message: JSON.stringify(m),
  };
}

/** RUNNING/PLANNING task with cancel_requested_at → CANCELLED (worker side of cancel). */
export async function finishCancellation(
  trx: Parameters<typeof lockTask>[0],
  ctx: DbContext,
  task: Awaited<ReturnType<typeof lockTask>>,
  /** Where the cancellation took effect: a checkpoint, or inside a running step (audit only). */
  at: 'checkpoint' | 'step' = 'checkpoint',
): Promise<void> {
  await closePendingApprovals(trx, task.id);
  await cancelOpenSteps(trx, task.id);
  await transitionTask(trx, ctx, task, 'CANCELLED', cancelledResult(task.language));
  await audit(trx, {
    tenantId: ctx.tenantId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'task.cancelled',
    targetType: 'task',
    targetId: task.id,
    metadata: { at },
  });
}

export async function handlePlanJob(deps: RuntimeDeps, job: JobRow): Promise<JobOutcome> {
  const ctx: DbContext = { tenantId: job.tenant_id, userId: job.user_id };
  const taskId = job.task_id;
  if (!taskId) return 'done';

  // Phase 1 — claim the task and gather context.
  const start = await withContext(deps.db, ctx, async (trx) => {
    const task = await tryLockTask(trx, taskId);
    // PLANNING here means a previous attempt of this (deduplicated) job died
    // mid-planning and the queue reclaimed it: resume instead of leaving it stuck.
    if (!task || (task.status !== 'QUEUED' && task.status !== 'PLANNING')) return null;
    if (task.cancel_requested_at) {
      if (task.status === 'PLANNING') await finishCancellation(trx, ctx, task);
      else {
        await cancelOpenSteps(trx, task.id);
        await transitionTask(trx, ctx, task, 'CANCELLED', cancelledResult(task.language));
      }
      return null;
    }
    const planning =
      task.status === 'QUEUED' ? await transitionTask(trx, ctx, task, 'PLANNING') : task;
    const agent = await loadAgentContext(trx, deps.config, ctx.userId);
    const steps = await trx
      .selectFrom('task_steps')
      .select('id')
      .where('task_id', '=', taskId)
      .execute();
    const language = asLocale(planning.language, agent.account.locale);
    const memories =
      steps.length === 0 && agent.route.mode === 'model' && agent.preferences.memory.enabled
        ? await relevantMemories(trx, planning.request, 10)
        : [];
    let conversation: PriorTurn[] = [];
    let attachments: PlanningAttachment[] = [];
    if (steps.length === 0) {
      conversation = await loadConversationContext(trx, planning.conversation_id, planning.id);
      attachments = (await conversationAttachments(trx, planning)).planning;
    }
    return {
      task: planning,
      agent,
      hasSteps: steps.length > 0,
      language,
      memories,
      conversation,
      attachments,
    };
  });
  if (!start) return 'done';

  // Phase 2 — plan (model or offline), outside any transaction.
  let outcome: PlanOutcome | null = null;
  if (!start.hasSteps) {
    const a = start.agent;
    const browserAvailable =
      deps.storage !== null && (await workerHealth(deps.db, 'browser')).healthy;
    const tools = availableTools({
      activeConnections: new Set(a.connections.keys()),
      memoryEnabled: a.preferences.memory.enabled,
      modelAvailable: a.route.mode === 'model',
      disabledSkills: a.preferences.skills?.disabled ?? [],
      hasAttachments: deps.storage !== null && start.attachments.length > 0,
      hasRecallable: start.conversation.some((t) => t.recallable),
      connections: a.connectionStates ?? [],
      browserAvailable,
      // Phase D
      telephonyAvailable: a.telephony?.configured === true,
    });
    outcome = await planTask(
      {
        config: deps.config,
        adapter: deps.adapter,
        route: a.route,
        signal: deps.signal,
        planningModel: a.preferences.ai.planningModel,
      },
      {
        request: start.task.request,
        language: start.language,
        account: {
          displayName: a.account.displayName,
          email: a.account.email,
          locale: a.account.locale,
          timeZone: a.account.timeZone,
        },
        tools,
        memories: start.memories,
        conversation: start.conversation,
        attachments: start.attachments,
        connections: a.connectionStates ?? [],
        browserAvailable,
        // Phase D
        telephonyAvailable: a.telephony?.configured === true,
        phoneRegion: a.telephony?.ownPhone?.region ?? null,
        ownPhoneVerified: a.telephony?.ownPhone?.verified === true,
      },
    ).catch((err: unknown): PlanOutcome => ({
      ok: false,
      error:
        err instanceof AgentError
          ? err
          : new AgentError('INTERNAL', 'Planning failed unexpectedly.', {
              retryable: true,
              reason: 'PLANNING_FAILED',
            }),
      planner: { mode: a.route.mode, provider: a.route.provider, model: null },
      usage: err instanceof AgentError ? err.usage : [],
    }));
  }

  // Phase 3 — persist the plan, check policies, start execution. A planning
  // call aborted because the lease was lost must not fail the task.
  checkLease(deps);
  return withContext(deps.db, ctx, async (trx): Promise<JobOutcome> => {
    let task = await lockTask(trx, taskId);
    const planningCost = outcome ? await recordUsage(trx, ctx, taskId, outcome.usage) : 0;
    if (task.status !== 'PLANNING') return 'done';
    if (planningCost > 0) task = await lockTask(trx, taskId);
    if (task.cancel_requested_at) {
      await finishCancellation(trx, ctx, task);
      return 'done';
    }
    if (outcome && !outcome.ok) {
      task = await patchTask(trx, task, { planner: JSON.stringify(outcome.planner) });
      await failTask(trx, ctx, task, outcome.error.toTaskError());
      return 'done';
    }

    if (outcome?.ok) {
      const plan = outcome.plan;
      await trx
        .insertInto('task_steps')
        .values(
          plan.steps.map((s, position) => ({
            tenant_id: ctx.tenantId,
            user_id: ctx.userId,
            task_id: taskId,
            position,
            step_key: s.key,
            title: s.title,
            title_message: s.titleMessage ? JSON.stringify(s.titleMessage) : null,
            tool_id: s.toolId,
            input: JSON.stringify(s.input),
            risk_level: 'LOW' as const,
          })),
        )
        .execute();
      task = await patchTask(trx, task, {
        title: plan.title,
        title_message: plan.titleMessage ? JSON.stringify(plan.titleMessage) : null,
        objective: plan.objective,
        objective_message: plan.objectiveMessage ? JSON.stringify(plan.objectiveMessage) : null,
        planner: JSON.stringify(outcome.planner satisfies PlannerInfo),
      });
      await titleConversation(trx, ctx, task, plan);
    }

    const steps: StepRow[] = await trx
      .selectFrom('task_steps')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('position')
      .execute();
    const agent: AgentContext = await loadAgentContext(trx, deps.config, ctx.userId);
    const language: Locale = asLocale(task.language, agent.account.locale);
    const files = costAttachments((await conversationAttachments(trx, task)).rows);

    // Already spent on this task (planning included) plus what the remaining steps should cost.
    let estimate = task.actual_cost_micro;
    const risks: RiskLevel[] = [];
    for (const step of steps) {
      if (FINISHED_STEP.has(step.status)) {
        risks.push(step.risk_level);
        continue;
      }
      const tool = getTool(step.tool_id);
      if (!tool) {
        await failTask(trx, ctx, task, {
          code: 'INTERNAL',
          message: `This task uses a tool that no longer exists (${step.tool_id}).`,
          retryable: false,
          reason: 'UNKNOWN_TOOL',
          params: { tool: step.tool_id },
        });
        return 'done';
      }
      const a = assessStep(tool, step.input, agent, deps.config, { attachments: files });
      estimate += a.estimateMicro;
      risks.push(a.risk);
      await trx
        .updateTable('task_steps')
        .set({
          risk_level: a.risk,
          policy: JSON.stringify({ decision: a.policy.decision, reasons: a.policy.reasons }),
          requires_approval: a.policy.decision === 'require_approval',
          input_preview: JSON.stringify(a.preview),
        })
        .where('id', '=', step.id)
        .execute();
      if (a.policy.decision === 'deny') {
        const error = denyError(tool, step.title, a.policy);
        await trx
          .updateTable('task_steps')
          .set({ status: 'BLOCKED', error: taskErrorJson(error), completed_at: new Date() })
          .where('id', '=', step.id)
          .execute();
        await appendEvent(trx, ctx, {
          taskId,
          type: 'step.blocked',
          data: { ...stepRef(step), reasons: a.policy.reasons },
        });
        task = await patchTask(trx, task, { risk_level: maxRisk(risks) });
        await failTask(trx, ctx, task, error);
        return 'done';
      }
    }
    if (agent.route.mode === 'model') {
      const rs = selectModel(deps.config, 'result_summary');
      estimate += costMicro(rs.model, { input: 1_500, output: 400 });
    }
    task = await patchTask(trx, task, {
      estimated_cost_micro: estimate,
      risk_level: maxRisk(risks),
      error: null,
    });
    await appendEvent(trx, ctx, {
      taskId,
      type: 'plan.ready',
      data: { stepCount: steps.length, planner: task.planner, language },
    });
    await transitionTask(trx, ctx, task, 'RUNNING');
    await enqueue(trx, {
      kind: 'task.execute',
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      taskId,
      dedupeKey: `exec:${taskId}`,
    });
    return 'done';
  });
}
