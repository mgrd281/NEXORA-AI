/**
 * Row → contract mappers and the shared task-summary query. Both the agent
 * runtime and the HTTP read models use these, so a task looks identical
 * wherever it is rendered.
 */
import {
  TaskEventType,
  canCancel,
  canRetry,
  type Approval,
  type ApprovalDetails,
  type Evidence,
  type TaskDetail,
  type TaskEvent,
  type TaskStep,
  type TaskSummary,
  type TaskError,
  type ToolId,
} from '@jarvis/contracts';
import type { Trx } from '../../db/pool';
import type { ApprovalRow, StepRow, TaskRow } from '../../db/types';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export interface TaskAggregate extends TaskRow {
  steps_done: number | null;
  steps_total: number | null;
  pending_approval_id: string | null;
}

/** Base query for TaskSummary lists: task columns + progress + pending approval. */
export function taskSummaryQuery(trx: Trx) {
  return trx
    .selectFrom('tasks as t')
    .selectAll('t')
    .select((eb) => [
      eb
        .selectFrom('task_steps as s')
        .whereRef('s.task_id', '=', 't.id')
        .where('s.status', 'in', ['SUCCEEDED', 'SKIPPED'])
        .select(eb.fn.countAll<number>().as('n'))
        .as('steps_done'),
      eb
        .selectFrom('task_steps as s')
        .whereRef('s.task_id', '=', 't.id')
        .select(eb.fn.countAll<number>().as('n'))
        .as('steps_total'),
      eb
        .selectFrom('approvals as a')
        .whereRef('a.task_id', '=', 't.id')
        .where('a.status', '=', 'PENDING')
        .select('a.id')
        .limit(1)
        .as('pending_approval_id'),
    ]);
}

function toTaskError(e: unknown): TaskError | null {
  if (!e || typeof e !== 'object') return null;
  const x = e as Partial<TaskError>;
  return {
    code: (x.code ?? 'INTERNAL') as TaskError['code'],
    message: x.message ?? '',
    retryable: !!x.retryable,
  };
}

export function toTaskSummary(t: TaskAggregate): TaskSummary {
  return {
    id: t.id,
    title: t.title,
    request: t.request,
    status: t.status,
    riskLevel: t.risk_level,
    source: t.source,
    progress: { completed: Number(t.steps_done ?? 0), total: Number(t.steps_total ?? 0) },
    pendingApprovalId: t.pending_approval_id ?? null,
    resultSummary: t.result_summary,
    error: toTaskError(t.error),
    createdAt: t.created_at.toISOString(),
    updatedAt: t.updated_at.toISOString(),
    completedAt: iso(t.completed_at),
  };
}

function toEvidence(list: unknown): Evidence[] {
  return Array.isArray(list) ? (list as Evidence[]) : [];
}

export function toTaskStep(s: StepRow): TaskStep {
  return {
    id: s.id,
    position: s.position,
    title: s.title,
    toolId: s.tool_id as ToolId,
    riskLevel: s.risk_level,
    status: s.status,
    requiresApproval: s.requires_approval,
    policy: s.policy,
    inputPreview: s.input_preview ?? {},
    output: s.output_preview ?? null,
    evidence: toEvidence(s.evidence),
    attempts: s.attempts,
    startedAt: iso(s.started_at),
    completedAt: iso(s.completed_at),
    error: toTaskError(s.error),
  };
}

export function toApproval(a: ApprovalRow & { task_title: string }): Approval {
  return {
    id: a.id,
    taskId: a.task_id,
    taskTitle: a.task_title,
    stepId: a.step_id,
    toolId: a.tool_id as ToolId,
    status: a.status,
    riskLevel: a.risk_level,
    summary: a.summary,
    details: a.details as ApprovalDetails,
    actionHash: a.action_hash,
    reasons: a.reasons,
    expiresAt: new Date(a.expires_at).toISOString(),
    decidedAt: iso(a.decided_at),
    decisionNote: a.decision_note,
    createdAt: a.created_at.toISOString(),
  };
}

/** Approvals joined with their task title. */
export function approvalQuery(trx: Trx) {
  return trx
    .selectFrom('approvals as a')
    .innerJoin('tasks as t', 't.id', 'a.task_id')
    .selectAll('a')
    .select('t.title as task_title');
}

export function toTaskEvent(e: {
  id: number;
  task_id: string | null;
  type: string;
  data: Record<string, unknown>;
  created_at: Date;
}): TaskEvent {
  return {
    id: String(e.id),
    taskId: e.task_id ?? '',
    type: e.type as TaskEvent['type'],
    at: e.created_at.toISOString(),
    data: e.data ?? {},
  };
}

/** Full task detail (one round trip per relation; all scoped by RLS). */
export async function loadTaskDetail(trx: Trx, taskId: string): Promise<TaskDetail | null> {
  const t = (await taskSummaryQuery(trx).where('t.id', '=', taskId).executeTakeFirst()) as
    TaskAggregate | undefined;
  if (!t) return null;
  const [steps, approvals, events] = await Promise.all([
    trx
      .selectFrom('task_steps')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('position')
      .execute(),
    approvalQuery(trx).where('a.task_id', '=', taskId).orderBy('a.created_at').execute(),
    trx
      .selectFrom('task_events')
      .select(['id', 'task_id', 'type', 'data', 'created_at'])
      .where('task_id', '=', taskId)
      // The same log also carries user-stream events tied to a task (e.g.
      // notification.created); the task timeline contract only has task events.
      .where('type', 'in', TaskEventType.options)
      .orderBy('id')
      .limit(500)
      .execute(),
  ]);
  return {
    ...toTaskSummary(t),
    objective: t.objective,
    conversationId: t.conversation_id,
    planner: t.planner ?? null,
    answer: t.answer,
    steps: steps.map(toTaskStep),
    approvals: approvals.map(toApproval),
    events: events.map(toTaskEvent),
    cost: { estimatedMicroUsd: t.estimated_cost_micro, actualMicroUsd: t.actual_cost_micro },
    evidence: toEvidence(t.evidence),
    canCancel: canCancel(t.status),
    canRetry: canRetry(t.status),
    startedAt: iso(t.started_at),
  };
}

export type { ApprovalDetails };
