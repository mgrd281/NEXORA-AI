/**
 * task.plan job: QUEUED → PLANNING → (plan, policy check) → RUNNING + task.execute.
 *
 * Three short transactions; no transaction is held across the model call.
 * On retry (the task already has steps) the model is skipped and only the
 * policies of unfinished steps are re-checked.
 */
import type { Locale, PlannerInfo, RiskLevel } from '@jarvis/contracts';
import { withContext, type DbContext } from '../../db/pool';
import type { JobRow, StepRow } from '../../db/types';
import { audit } from '../audit/audit';
import { appendEvent } from '../events/events';
import { enqueue } from '../jobs/queue';
import { loadAgentContext, relevantMemories, type AgentContext } from './context';
import { AgentError } from './errors';
import { asLocale, msg, render } from './i18n';
import { costMicro } from './models/pricing';
import { selectModel } from './models/router';
import { planTask, type PlanOutcome } from './planner';
import { denyMessage, denyReason } from './policy';
import { checkLease, type RuntimeDeps } from './runtime';
import { stepRef } from './events-data';
import { assessStep, maxRisk } from './step-policy';
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
    metadata: { at: 'checkpoint' },
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
    return { task: planning, agent, hasSteps: steps.length > 0, language, memories };
  });
  if (!start) return 'done';

  // Phase 2 — plan (model or offline), outside any transaction.
  let outcome: PlanOutcome | null = null;
  if (!start.hasSteps) {
    const a = start.agent;
    const tools = availableTools({
      activeConnections: new Set(a.connections.keys()),
      memoryEnabled: a.preferences.memory.enabled,
      modelAvailable: a.route.mode === 'model',
    });
    outcome = await planTask(
      { config: deps.config, adapter: deps.adapter, route: a.route, signal: deps.signal },
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
    }

    const steps: StepRow[] = await trx
      .selectFrom('task_steps')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('position')
      .execute();
    const agent: AgentContext = await loadAgentContext(trx, deps.config, ctx.userId);
    const language: Locale = asLocale(task.language, agent.account.locale);

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
      const a = assessStep(tool, step.input, agent, deps.config);
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
        const code = a.policy.denyCode ?? 'POLICY_DENIED';
        const error = {
          code,
          message: denyMessage(code, a.policy.reasons, step.title),
          retryable: true,
          reason: denyReason(code, a.policy.reasons),
          params: { step: step.title },
        };
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
