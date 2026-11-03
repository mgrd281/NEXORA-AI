import type { TaskStatus } from './enums';

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

export function canRetry(status: TaskStatus): boolean {
  return canTransition(status, 'QUEUED');
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
