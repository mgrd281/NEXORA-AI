/**
 * task.execute job: runs steps in order with durable checkpoints.
 *
 * Per step:
 *   1. (tx) cancel checkpoint; resolve {{refs}} into resolved_input; re-run the
 *      policy on the resolved input; deny → BLOCKED/FAILED; approval needed and
 *      no APPROVED approval bound to hash({toolId, resolvedInput}) → PENDING
 *      approval + AWAITING_APPROVAL, stop.
 *   2. (tx) claim: insert the tool_executions row *before* the side effect.
 *      once_per_step → key '<stepId>'; a 'succeeded' row is reused, a 'failed'
 *      row (definitely not executed) is re-claimed, a 'started'/'unknown' row
 *      of an external tool means the outcome is unknown → OUTCOME_UNKNOWN.
 *      safe_to_retry → key '<stepId>:a<n>'.
 *   3. execute with timeout (AbortController), no tx held.
 *   4. (tx) record outcome, usage and cost, events, audit.
 * After the last step: VERIFYING → verify every step → COMPLETED (or FAILED).
 *
 * The worker holds the job's lease for the whole run. If it is lost anyway
 * (deps.signal), in-flight tool and model calls are aborted and the job stops
 * at the next checkpoint (checkLease) without writing anything more: another
 * worker may own it by then, and claimExecution there deals with the
 * interrupted attempt.
 */
import type { ConnectionProvider, Evidence, Locale, VerificationCheck } from '@jarvis/contracts';
import { withContext, type DbContext } from '../../db/pool';
import type { AttachmentRow, JobRow, StepRow, TaskRow, ToolExecutionRow } from '../../db/types';
import { hashObject } from '../../lib/crypto';
import { redact, truncate } from '../../lib/redact';
import { metrics } from '../../observability/metrics';
import { withSpan } from '../../observability/tracing';
import { audit } from '../audit/audit';
import { enabledOrigins } from '../browser/sites';
import { appendEvent, publishEphemeral } from '../events/events';
import { createNotification } from '../notifications/create';
import { requestApproval } from './approval-flow';
import { insertAssistantMessage, questionOf, taskOutcome } from './completion';
import { loadAgentContext, stepCommittedSpend, type AgentContext } from './context';
import { loadConversationContext, type PriorTurn } from './conversation-context';
import { AgentError, asAgentError } from './errors';
import type { ModelUsage } from './models/adapter';
import { asLocale, asMessage } from './i18n';
import {
  conversationAttachments,
  costAttachments,
  finishCancellation,
  type JobOutcome,
} from './plan-job';
import { deterministicSummary, modelSummary } from './result-summary';
import { checkLease, withLeaseSignal, type RuntimeDeps } from './runtime';
import { stepRef } from './events-data';
import { assessStep, denyError, isTainted, untrustedSource } from './step-policy';
import {
  failTask,
  lockTask,
  tryLockTask,
  recordToolCost,
  recordUsage,
  taskErrorJson,
  transitionTask,
} from './task-state';
import { findRefs, resolveTemplates } from './templates';
import { getTool } from './tools/registry';
import type { AnyTool, ToolResult, ToolRuntime } from './tools/types';

const FINISHED = new Set(['SUCCEEDED', 'SKIPPED']);

/** The optional model-written result line gives up after this long (deterministic line instead). */
export const RESULT_SUMMARY_TIMEOUT_MS = 30_000;

type Prepared =
  | { kind: 'stop' }
  | { kind: 'awaiting' }
  | { kind: 'verify' }
  | {
      kind: 'run';
      task: TaskRow;
      step: StepRow;
      tool: AnyTool;
      input: Record<string, unknown>;
      agent: AgentContext;
      language: Locale;
      /** Files of the task's conversation (document.analyze reads only these). */
      files: AttachmentRow[];
      /** Earlier turns of the conversation. */
      conversation: PriorTurn[];
    };

/** The earlier task a conversation.recall step that `step` depends on reads (for approvals). */
function recalledTaskId(steps: StepRow[], step: StepRow): string | null {
  for (const ref of findRefs(step.input)) {
    const dep = steps.find((s) => s.step_key === ref.stepKey);
    if (dep?.tool_id !== 'conversation.recall') continue;
    const id = ((dep.resolved_input ?? dep.input) as Record<string, unknown>).taskId;
    if (typeof id === 'string') return id;
  }
  return null;
}

async function loadSteps(trx: Parameters<typeof lockTask>[0], taskId: string): Promise<StepRow[]> {
  return trx
    .selectFrom('task_steps')
    .selectAll()
    .where('task_id', '=', taskId)
    .orderBy('position')
    .execute();
}

async function failStep(
  trx: Parameters<typeof lockTask>[0],
  ctx: DbContext,
  task: TaskRow,
  step: StepRow,
  err: AgentError,
  status: 'FAILED' | 'BLOCKED' = 'FAILED',
  reasons: string[] = [err.code],
): Promise<void> {
  const error = err.toTaskError();
  await trx
    .updateTable('task_steps')
    .set({ status, error: taskErrorJson(error), completed_at: new Date() })
    .where('id', '=', step.id)
    .execute();
  await appendEvent(trx, ctx, {
    taskId: task.id,
    type: status === 'BLOCKED' ? 'step.blocked' : 'step.failed',
    data:
      status === 'BLOCKED'
        ? { ...stepRef(step), reasons }
        : {
            ...stepRef(step),
            code: error.code,
            message: error.message,
            ...(error.reason ? { reason: error.reason } : {}),
            ...(error.params ? { params: error.params } : {}),
          },
  });
  await failTask(trx, ctx, task, error);
}

/* ------------------------------------------------------------------ */
/* 1. Prepare the next step                                            */
/* ------------------------------------------------------------------ */

async function prepareNext(deps: RuntimeDeps, ctx: DbContext, taskId: string): Promise<Prepared> {
  return withContext(deps.db, ctx, async (trx) => {
    const task = await tryLockTask(trx, taskId);
    if (!task) return { kind: 'stop' };
    if (task.status !== 'RUNNING') return { kind: 'stop' };
    if (task.cancel_requested_at) {
      await finishCancellation(trx, ctx, task);
      return { kind: 'stop' };
    }
    const steps = await loadSteps(trx, taskId);
    const step = steps.find((s) => !FINISHED.has(s.status));
    if (!step) return { kind: 'verify' };
    const tool = getTool(step.tool_id);
    if (!tool) {
      await failStep(
        trx,
        ctx,
        task,
        step,
        new AgentError('INTERNAL', `Unknown tool ${step.tool_id}.`, {
          reason: 'UNKNOWN_TOOL',
          params: { tool: step.tool_id },
        }),
      );
      return { kind: 'stop' };
    }
    const loaded = await loadAgentContext(trx, deps.config, ctx.userId);
    // A purchase step retried after an unknown outcome reconciles its own row: that row must
    // not count against the limit it is checked against (nor in the approval's limit bar).
    const own =
      tool.purchase && loaded.purchases
        ? await stepCommittedSpend(trx, step.id, loaded.account.timeZone)
        : 0;
    const agent: typeof loaded =
      own > 0 && loaded.purchases
        ? {
            ...loaded,
            purchases: {
              ...loaded.purchases,
              spentMicro: Math.max(0, loaded.purchases.spentMicro - own),
            },
          }
        : loaded;
    const language = asLocale(task.language, agent.account.locale);

    // Resolve references from earlier steps' stored outputs.
    const outputs = Object.fromEntries(
      steps.filter((s) => FINISHED.has(s.status)).map((s) => [s.step_key, s.output ?? {}]),
    );
    let resolved: Record<string, unknown>;
    try {
      resolved = resolveTemplates(step.input, outputs);
    } catch (err) {
      await failStep(trx, ctx, task, step, asAgentError(err));
      return { kind: 'stop' };
    }
    const parsed = tool.inputSchema.safeParse(resolved);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
        .join('; ');
      await failStep(
        trx,
        ctx,
        task,
        step,
        new AgentError('TOOL_FAILED', `The input for “${step.title}” is not valid: ${detail}`, {
          reason: 'INVALID_STEP_INPUT',
          params: { step: step.title },
        }),
      );
      return { kind: 'stop' };
    }
    const input = parsed.data as Record<string, unknown>;
    const files = (await conversationAttachments(trx, task)).rows;
    // Text taken from earlier steps (a reference in the planned input) is content, not the user's words.
    const fromContent = findRefs(step.input).length > 0;

    // Policy on the exact input that would run.
    const a = assessStep(tool, input, agent, deps.config, {
      untrustedContent: isTainted(steps, step),
      fromContent,
      attachments: costAttachments(files),
    });
    await trx
      .updateTable('task_steps')
      .set({
        resolved_input: JSON.stringify(input),
        input_preview: JSON.stringify(a.preview),
        risk_level: a.risk,
        policy: JSON.stringify({ decision: a.policy.decision, reasons: a.policy.reasons }),
        requires_approval: a.policy.decision === 'require_approval',
      })
      .where('id', '=', step.id)
      .execute();

    if (a.policy.decision === 'deny') {
      const e = denyError(tool, step.title, a.policy);
      await failStep(
        trx,
        ctx,
        task,
        step,
        new AgentError(e.code, e.message, {
          retryable: e.retryable,
          reason: e.reason,
          params: e.params,
        }),
        'BLOCKED',
        a.policy.reasons,
      );
      return { kind: 'stop' };
    }

    if (a.policy.decision === 'require_approval') {
      const actionHash = hashObject({ toolId: tool.id, resolvedInput: input });
      const approved = await trx
        .selectFrom('approvals')
        .select('id')
        .where('step_id', '=', step.id)
        .where('status', '=', 'APPROVED')
        .where('action_hash', '=', actionHash)
        .executeTakeFirst();
      if (!approved) {
        const pending = await trx
          .selectFrom('approvals')
          .selectAll()
          .where('step_id', '=', step.id)
          .where('status', '=', 'PENDING')
          .executeTakeFirst();
        if (pending && pending.action_hash === actionHash) {
          // Already waiting on exactly this action (e.g. a duplicate job).
          await trx
            .updateTable('task_steps')
            .set({ status: 'AWAITING_APPROVAL' })
            .where('id', '=', step.id)
            .execute();
          await transitionTask(trx, ctx, task, 'AWAITING_APPROVAL');
          return { kind: 'awaiting' };
        }
        if (pending) {
          await trx
            .updateTable('approvals')
            .set({ status: 'SUPERSEDED', decided_at: new Date() })
            .where('id', '=', pending.id)
            .execute();
        }
        const smtp = agent.connections.get('smtp');
        const smtpCfg = (smtp?.config ?? {}) as { fromAddress?: string; fromName?: string };
        const fromAddress = smtpCfg.fromAddress
          ? smtpCfg.fromName
            ? `${smtpCfg.fromName} <${smtpCfg.fromAddress}>`
            : smtpCfg.fromAddress
          : null;
        const accounts: Partial<Record<ConnectionProvider, string | null>> = {};
        for (const c of agent.connectionStates ?? [])
          if (c.status === 'active') accounts[c.provider] = c.accountIdentifier;
        const { details, summary, summaryMessage } = tool.approvalDetails(input, {
          language,
          stepTitle: step.title,
          stepTitleMessage: asMessage(step.title_message),
          fromAddress,
          fromContent,
          recalledTaskId: recalledTaskId(steps, step),
          now: new Date(),
          // Phase C: the accounts and limits approvals show (calendar, sender, purchases).
          account: { email: agent.account.email, timeZone: agent.account.timeZone },
          accounts,
          purchases: agent.purchases ?? { limitMicro: 0, spentMicro: 0 },
          siteHost: (siteId) => {
            const origin = enabledOrigins(deps.config, siteId)?.[0];
            return origin ? new URL(origin).host : null;
          },
        });
        // Say what the suspected injection is about (never the flagged text itself).
        const untrusted = a.policy.reasons.includes('UNTRUSTED_CONTENT')
          ? untrustedSource(steps, step)
          : null;
        await requestApproval(trx, ctx, deps.config, {
          task,
          step,
          toolId: tool.id,
          risk: a.risk,
          summary,
          summaryMessage,
          details: untrusted ? { ...details, untrusted } : details,
          actionHash,
          reasons: a.policy.reasons,
        });
        return { kind: 'awaiting' };
      }
    }
    const conversation =
      tool.id === 'conversation.recall'
        ? await loadConversationContext(trx, task.conversation_id, task.id)
        : [];
    return {
      kind: 'run',
      task,
      step: { ...step, resolved_input: input },
      tool,
      input,
      agent,
      language,
      files,
      conversation,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 2–4. Run one step                                                   */
/* ------------------------------------------------------------------ */

type Claim =
  | { kind: 'stop' }
  | { kind: 'reuse'; exec: ToolExecutionRow }
  | { kind: 'run'; executionId: string; key: string };

async function claimExecution(
  deps: RuntimeDeps,
  ctx: DbContext,
  p: Extract<Prepared, { kind: 'run' }>,
): Promise<Claim> {
  const { tool, step, input } = p;
  const inputHash = hashObject(input);
  return withContext(deps.db, ctx, async (trx) => {
    const task = await lockTask(trx, step.task_id);
    if (task.status !== 'RUNNING') return { kind: 'stop' };
    const current = await trx
      .selectFrom('task_steps')
      .selectAll()
      .where('id', '=', step.id)
      .forUpdate()
      .executeTakeFirstOrThrow();

    let key: string;
    let executionId: string;
    if (tool.idempotency === 'once_per_step') {
      key = step.id;
      const existing = await trx
        .selectFrom('tool_executions')
        .selectAll()
        .where('idempotency_key', '=', key)
        .forUpdate()
        .executeTakeFirst();
      if (existing?.status === 'succeeded') return { kind: 'reuse', exec: existing };
      if (existing && (existing.status === 'started' || existing.status === 'unknown')) {
        if (tool.sideEffect === 'external') {
          // A previous attempt may have performed the side effect: never repeat it.
          await trx
            .updateTable('tool_executions')
            .set({ status: 'unknown', finished_at: existing.finished_at ?? new Date() })
            .where('id', '=', existing.id)
            .execute();
          const err = new AgentError(
            'OUTCOME_UNKNOWN',
            `JARVIS was interrupted while running “${step.title}” and cannot tell whether it completed. Check the result yourself (for email: your Sent folder) before retrying.`,
            { retryable: false, reason: 'STEP_INTERRUPTED', params: { step: step.title } },
          );
          await failStep(trx, ctx, task, current, err);
          await audit(trx, {
            tenantId: ctx.tenantId,
            actorType: 'agent',
            actorId: ctx.userId,
            action: 'tool.outcome_unknown',
            targetType: 'task_step',
            targetId: step.id,
            metadata: { taskId: step.task_id, toolId: tool.id },
          });
          return { kind: 'stop' };
        }
      }
      if (existing) {
        // 'failed' (definitely not executed) or an interrupted internal tool: re-claim.
        await trx
          .updateTable('tool_executions')
          .set({
            status: 'started',
            input_hash: inputHash,
            tool_version: tool.version,
            started_at: new Date(),
            finished_at: null,
            duration_ms: null,
            error: null,
          })
          .where('id', '=', existing.id)
          .execute();
        executionId = existing.id;
      } else {
        const row = await trx
          .insertInto('tool_executions')
          .values({
            tenant_id: ctx.tenantId,
            user_id: ctx.userId,
            task_id: step.task_id,
            step_id: step.id,
            tool_id: tool.id,
            tool_version: tool.version,
            idempotency_key: key,
            status: 'started',
            input_hash: inputHash,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        executionId = row.id;
      }
    } else {
      // Attempts interrupted by a crash are safe to abandon for these tools.
      await trx
        .updateTable('tool_executions')
        .set({
          status: 'failed',
          finished_at: new Date(),
          error: taskErrorJson({ code: 'INTERNAL', message: 'Interrupted', retryable: true }),
        })
        .where('step_id', '=', step.id)
        .where('status', '=', 'started')
        .execute();
      key = `${step.id}:a${current.attempts + 1}`;
      const row = await trx
        .insertInto('tool_executions')
        .values({
          tenant_id: ctx.tenantId,
          user_id: ctx.userId,
          task_id: step.task_id,
          step_id: step.id,
          tool_id: tool.id,
          tool_version: tool.version,
          idempotency_key: key,
          status: 'started',
          input_hash: inputHash,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      executionId = row.id;
    }
    await trx
      .updateTable('task_steps')
      .set({
        status: 'RUNNING',
        attempts: current.attempts + 1,
        started_at: current.started_at ?? new Date(),
        error: null,
      })
      .where('id', '=', step.id)
      .execute();
    await appendEvent(trx, ctx, {
      taskId: step.task_id,
      type: 'step.started',
      data: { ...stepRef(step), attempt: current.attempts + 1 },
    });
    return { kind: 'run', executionId, key };
  });
}

function abortRejection(signal: AbortSignal, tool: AnyTool, title: string): Promise<never> {
  return new Promise((_, reject) => {
    const onAbort = () =>
      reject(
        tool.sideEffect === 'external'
          ? new AgentError(
              'OUTCOME_UNKNOWN',
              `“${title}” did not finish in time, so JARVIS cannot tell whether it completed.`,
              { reason: 'STEP_TIMEOUT', params: { step: title } },
            )
          : new AgentError('TOOL_TIMEOUT', `“${title}” did not finish in time.`, {
              retryable: true,
              transient: true,
              reason: 'STEP_TIMEOUT',
              params: { step: title },
            }),
      );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeToolError(err: unknown, tool: AnyTool, title: string): AgentError {
  if (err instanceof AgentError) return err;
  // An unexpected exception inside an external tool leaves its outcome unknown.
  if (tool.sideEffect === 'external') {
    return new AgentError(
      'OUTCOME_UNKNOWN',
      'The action failed unexpectedly, so JARVIS cannot tell whether it completed.',
      { reason: 'STEP_CRASHED', params: { step: title } },
    );
  }
  return asAgentError(err);
}

async function recordSuccess(
  deps: RuntimeDeps,
  ctx: DbContext,
  p: Extract<Prepared, { kind: 'run' }>,
  executionId: string,
  result: ToolResult,
  durationMs: number,
): Promise<void> {
  const { step, tool, input } = p;
  await withContext(deps.db, ctx, async (trx) => {
    await trx
      .updateTable('tool_executions')
      .set({
        status: 'succeeded',
        output: JSON.stringify(result.output),
        evidence: JSON.stringify(result.evidence),
        cost_micro: result.costMicro,
        finished_at: new Date(),
        duration_ms: durationMs,
        error: null,
      })
      .where('id', '=', executionId)
      .execute();
    await markStepSucceeded(
      trx,
      ctx,
      step,
      tool,
      result.output,
      result.outputPreview,
      result.evidence,
    );
    const modelCost = await recordUsage(trx, ctx, step.task_id, result.usage ?? []);
    await recordToolCost(trx, ctx, step.task_id, result.costMicro - modelCost);
    if (result.answer !== undefined) {
      await trx
        .updateTable('tasks')
        .set({ answer: result.answer })
        .where('id', '=', step.task_id)
        .execute();
    }
    const entry = tool.audit?.(input, result.output);
    if (entry) {
      await audit(trx, {
        tenantId: ctx.tenantId,
        actorType: 'agent',
        actorId: ctx.userId,
        action: entry.action,
        targetType: 'task_step',
        targetId: step.id,
        metadata: { ...entry.metadata, taskId: step.task_id, toolExecutionId: executionId },
      });
    }
  });
}

async function markStepSucceeded(
  trx: Parameters<typeof lockTask>[0],
  ctx: DbContext,
  step: StepRow,
  tool: AnyTool,
  output: Record<string, unknown>,
  preview: Record<string, unknown>,
  evidence: Evidence[],
): Promise<void> {
  await trx
    .updateTable('task_steps')
    .set({
      status: 'SUCCEEDED',
      output: JSON.stringify(output),
      output_preview: JSON.stringify(preview),
      evidence: JSON.stringify(evidence),
      completed_at: new Date(),
      error: null,
    })
    .where('id', '=', step.id)
    .execute();
  await appendEvent(trx, ctx, {
    taskId: step.task_id,
    type: 'step.succeeded',
    data: stepRef(step),
  });
}

/** Display-safe copy of a stored output (long strings shortened, secrets redacted). */
function safePreview(output: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(redact(output)))
    out[k] = typeof v === 'string' ? truncate(v, 500) : v;
  return out;
}

function backoffMs(attempt: number): number {
  return Math.min(5_000, 250 * 2 ** (attempt - 1));
}

/** Runs one step to a recorded outcome. Returns false when the task stopped. */
async function runStep(
  deps: RuntimeDeps,
  ctx: DbContext,
  p: Extract<Prepared, { kind: 'run' }>,
): Promise<boolean> {
  const { tool, step, input } = p;
  const maxAttempts =
    tool.idempotency === 'safe_to_retry' ? Math.max(1, tool.retry.maxAttempts) : 1;
  for (let attempt = 1; ; attempt++) {
    checkLease(deps);
    const claim = await claimExecution(deps, ctx, p);
    if (claim.kind === 'stop') return false;
    if (claim.kind === 'reuse') {
      // The side effect already happened and was recorded: reuse it, never repeat it.
      await withContext(deps.db, ctx, (trx) =>
        markStepSucceeded(
          trx,
          ctx,
          step,
          tool,
          claim.exec.output ?? {},
          safePreview(claim.exec.output ?? {}),
          (claim.exec.evidence ?? []) as Evidence[],
        ),
      );
      return true;
    }

    const rt: ToolRuntime = {
      config: deps.config,
      db: deps.db,
      secrets: deps.secrets,
      ctx,
      taskId: step.task_id,
      stepId: step.id,
      idempotencyKey: claim.key,
      account: p.agent.account,
      preferences: p.agent.preferences,
      connections: p.agent.connections,
      language: p.language,
      model: p.agent.route.mode === 'model' ? deps.adapter : null,
      publishDelta: (text) =>
        publishEphemeral(deps.db, ctx, {
          taskId: step.task_id,
          type: 'task.answer.delta',
          data: { stepId: step.id, text },
        }),
      storage: deps.storage,
      conversationId: p.task.conversation_id,
      attachments: p.files,
      conversation: p.conversation,
    };

    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), tool.timeoutMs);
    // Aborted on timeout, or when the lease is lost.
    const signal = withLeaseSignal(deps, ac.signal);
    let result: ToolResult | null = null;
    let error: AgentError | null = null;
    try {
      result = await withSpan(
        'tool.execute',
        {
          'jarvis.tool_id': tool.id,
          'jarvis.tool.version': tool.version,
          'jarvis.tool.side_effect': tool.sideEffect,
          'jarvis.step.attempt': attempt,
        },
        () =>
          Promise.race([tool.execute(input, rt, signal), abortRejection(signal, tool, step.title)]),
      );
    } catch (err) {
      error = normalizeToolError(err, tool, step.title);
    } finally {
      clearTimeout(timer);
      if (!ac.signal.aborted) ac.abort(); // release the abort listener
    }
    metrics.toolExecution(
      tool.id,
      result ? 'succeeded' : error?.code === 'OUTCOME_UNKNOWN' ? 'unknown' : 'failed',
      Date.now() - started,
    );
    // Lease lost: whatever happened is for the worker that owns the job now to find
    // (a 'started' execution: re-run if safe, OUTCOME_UNKNOWN if external).
    checkLease(deps);
    if (result && deps.testHooks?.afterToolExecute) await deps.testHooks.afterToolExecute(tool.id);
    const durationMs = Date.now() - started;

    if (result) {
      await recordSuccess(deps, ctx, p, claim.executionId, result, durationMs);
      return true;
    }
    const e = error!;
    const autoRetry =
      tool.idempotency === 'safe_to_retry' &&
      e.transient &&
      tool.retry.retryableCodes.includes(e.code) &&
      attempt < maxAttempts;
    const stopped = await withContext(deps.db, ctx, async (trx) => {
      await trx
        .updateTable('tool_executions')
        .set({
          status: e.code === 'OUTCOME_UNKNOWN' ? 'unknown' : 'failed',
          error: taskErrorJson(e.toTaskError()),
          finished_at: new Date(),
          duration_ms: durationMs,
        })
        .where('id', '=', claim.executionId)
        .execute();
      await recordUsage(trx, ctx, step.task_id, e.usage);
      if (autoRetry) return false;
      const task = await lockTask(trx, step.task_id);
      if (task.status !== 'RUNNING') return true;
      await failStep(trx, ctx, task, step, e);
      return true;
    });
    if (stopped) return false;
    deps.log.warn('retrying step', {
      taskId: step.task_id,
      stepId: step.id,
      code: e.code,
      attempt,
    });
    await new Promise((r) => setTimeout(r, backoffMs(attempt)));
  }
}

/* ------------------------------------------------------------------ */
/* Verification & completion                                           */
/* ------------------------------------------------------------------ */

async function verifyAndComplete(deps: RuntimeDeps, ctx: DbContext, taskId: string): Promise<void> {
  checkLease(deps);
  const verified = await withContext(deps.db, ctx, async (trx) => {
    const task = await lockTask(trx, taskId);
    // VERIFYING here means a previous attempt died while completing: resume.
    if (task.status !== 'RUNNING' && task.status !== 'VERIFYING') return null;
    const verifying =
      task.status === 'RUNNING' ? await transitionTask(trx, ctx, task, 'VERIFYING') : task;
    const steps = await loadSteps(trx, taskId);
    // Each check as data (key + params) with its English line as the fallback.
    const checks: VerificationCheck[] = [];
    const failed: StepRow[] = [];
    for (const s of steps) {
      if (s.status !== 'SUCCEEDED') continue;
      const tool = getTool(s.tool_id);
      if (!tool) continue;
      const v = tool.verify(s.resolved_input ?? s.input, s.output ?? {});
      checks.push(
        ...v.checks.map((c) => ({
          stepId: s.id,
          step: s.title,
          key: c.key,
          params: c.params,
          text: c.text,
        })),
      );
      if (!v.ok) failed.push(s);
    }
    if (failed.length) {
      const external = failed.some((s) => getTool(s.tool_id)?.sideEffect === 'external');
      const names = failed.map((s) => `“${s.title}”`).join(', ');
      const message = `Verification failed for: ${names}.`;
      await appendEvent(trx, ctx, {
        taskId,
        type: 'verification.failed',
        data: { checks, message, stepIds: failed.map((s) => s.id) },
      });
      await failTask(trx, ctx, verifying, {
        code: 'VERIFICATION_FAILED',
        message,
        retryable: !external,
        reason: 'VERIFICATION_FAILED',
        params: { steps: failed.map((s) => s.title).join(', ') },
      });
      return null;
    }
    await appendEvent(trx, ctx, { taskId, type: 'verification.passed', data: { checks } });
    const agent = await loadAgentContext(trx, deps.config, ctx.userId);
    return {
      task: verifying,
      steps,
      agent,
      language: asLocale(task.language, agent.account.locale),
    };
  });
  if (!verified) return;

  const deterministic = deterministicSummary(verified.steps, verified.language);
  const fallback = deterministic.text;
  let summary = fallback;
  // Server sentences stay data so clients render them in the viewer's locale;
  // model-written and page text is only ever in the request's language.
  let summaryMessage = deterministic.message;
  const usage: ModelUsage[] = [];
  const question = questionOf(verified.steps);
  const outcome = taskOutcome(verified.steps);
  // An answer or a question is its own result line: no model rewrite.
  const answerOnly = verified.steps.some((s) => s.tool_id === 'assistant.answer') || !!question;
  if (deps.adapter && verified.agent.route.mode === 'model' && !answerOnly) {
    try {
      const res = await modelSummary(deps.adapter, deps.config, {
        request: verified.task.request,
        language: verified.language,
        steps: verified.steps,
        fallback,
        signal: withLeaseSignal(deps, AbortSignal.timeout(RESULT_SUMMARY_TIMEOUT_MS)),
      });
      usage.push(res.usage);
      if (res.text) {
        summary = res.text;
        summaryMessage = null;
      }
    } catch (err) {
      if (err instanceof AgentError) usage.push(...err.usage);
      deps.log.warn('result summary model call failed; using deterministic summary', {
        taskId,
        error: String(err),
      });
    }
  }

  checkLease(deps); // lost while summarizing: the new owner summarizes (and bills) again
  await withContext(deps.db, ctx, async (trx) => {
    await recordUsage(trx, ctx, taskId, usage);
    const task = await lockTask(trx, taskId);
    if (task.status !== 'VERIFYING') return;
    const evidence = verified.steps.flatMap((s) => (Array.isArray(s.evidence) ? s.evidence : []));
    // Status, outcome and question in one UPDATE (the CHECKs tie them together).
    const done = await transitionTask(trx, ctx, task, 'COMPLETED', {
      result_summary: summary || null,
      result_summary_message: summary && summaryMessage ? JSON.stringify(summaryMessage) : null,
      evidence: JSON.stringify(evidence),
      error: null,
      outcome,
      question: question ? JSON.stringify(question) : null,
    });
    await insertAssistantMessage(trx, ctx, done, verified.steps, {
      outcome,
      question,
      summary,
      summaryMessage,
    });
    await createNotification(trx, ctx, 'task_completed', taskId, { taskTitle: done.title });
  });
}

/* ------------------------------------------------------------------ */
/* Job entry                                                           */
/* ------------------------------------------------------------------ */

export async function handleExecuteJob(deps: RuntimeDeps, job: JobRow): Promise<JobOutcome> {
  const ctx: DbContext = { tenantId: job.tenant_id, userId: job.user_id };
  const taskId = job.task_id;
  if (!taskId) return 'done';
  const status = await taskStatus(deps, ctx, taskId);
  if (status === 'VERIFYING') {
    await verifyAndComplete(deps, ctx, taskId);
    return 'done';
  }
  for (;;) {
    checkLease(deps);
    const next = await prepareNext(deps, ctx, taskId);
    if (next.kind === 'stop') return 'done';
    if (next.kind === 'awaiting') return 'awaiting_approval';
    if (next.kind === 'verify') {
      await verifyAndComplete(deps, ctx, taskId);
      return 'done';
    }
    const ok = await runStep(deps, ctx, next);
    if (!ok) return 'done';
  }
}

/** Current status of a task (used by the worker's post-job reconciliation). */
export async function taskStatus(deps: RuntimeDeps, ctx: DbContext, taskId: string) {
  return withContext(deps.db, ctx, async (trx) => {
    const row = await trx
      .selectFrom('tasks')
      .select(['status'])
      .where('id', '=', taskId)
      .executeTakeFirst();
    return row?.status ?? null;
  });
}
