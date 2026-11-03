import type { ErrorCode, TaskStatus } from './enums';

/**
 * The task lifecycle. Shared by the backend (which enforces it inside a
 * transaction with optimistic locking) and clients (which use it to decide
 * which controls to show — never to fake a state).
 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
];
export const ACTIVE_STATUSES: readonly TaskStatus[] = [
  'QUEUED',
  'PLANNING',
  'AWAITING_APPROVAL',
  'RUNNING',
  'VERIFYING',
];

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  QUEUED: ['PLANNING', 'CANCELLED', 'EXPIRED', 'FAILED'],
  PLANNING: ['RUNNING', 'AWAITING_APPROVAL', 'FAILED', 'CANCELLED'],
  AWAITING_APPROVAL: ['RUNNING', 'CANCELLED', 'EXPIRED', 'FAILED'],
  RUNNING: ['AWAITING_APPROVAL', 'VERIFYING', 'FAILED', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: ['QUEUED'],
  CANCELLED: [],
  EXPIRED: ['QUEUED'],
};

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function canCancel(status: TaskStatus): boolean {
  return canTransition(status, 'CANCELLED');
}

/** Whether the status allows a retry at all (see canRetryTask for whether it can help). */
export function canRetry(status: TaskStatus): boolean {
  return canTransition(status, 'QUEUED');
}

export interface RetryContext {
  /** Whether an AI model is available to this user now (assistant status planner.mode === 'model'). */
  modelAvailable?: boolean;
}

/**
 * Whether retrying a task can help: the status allows it AND the last error
 * is not one that would only happen again.
 *  - EXPIRED (the approval timed out) and transient errors: yes.
 *  - OUTCOME_UNKNOWN: yes, after the user confirms they checked (RetryTaskRequest).
 *  - PLANNER_UNSUPPORTED: only once an AI model is available.
 *  - Anything the server marked non-retryable (FETCH_BLOCKED, invalid input,
 *    HTTP 404, unsupported content…): no; asking differently is the way forward.
 * This is what TaskDetail.canRetry reports and what the retry endpoint enforces.
 */
export function canRetryTask(
  task: { status: TaskStatus; error: { code: ErrorCode; retryable: boolean } | null },
  ctx: RetryContext = {},
): boolean {
  const { status, error } = task;
  if (!canRetry(status)) return false;
  if (status === 'EXPIRED' || !error) return true;
  if (error.code === 'OUTCOME_UNKNOWN') return true;
  if (error.code === 'PLANNER_UNSUPPORTED') return ctx.modelAvailable === true;
  return error.retryable;
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`Invalid task transition ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
