import type { ErrorCode, TaskError } from '@jarvis/contracts';
import { AppError } from '../../lib/errors';
import type { ModelUsage } from './models/adapter';

/**
 * A failure inside the agent runtime that is safe to show to the user.
 *
 * - `retryable`: retrying the task may succeed AND cannot cause a duplicate side
 *   effect (this is what TaskError.retryable means to clients). OUTCOME_UNKNOWN
 *   is never retryable.
 * - `transient`: worth an automatic retry inside the same step (network blips,
 *   5xx, timeouts). Only honoured for tools declared `safe_to_retry`.
 * - `usage`: model usage already incurred before the failure, so it is billed.
 */
export class AgentError extends AppError {
  readonly retryable: boolean;
  readonly transient: boolean;
  readonly usage: ModelUsage[];

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable?: boolean; transient?: boolean; usage?: ModelUsage[] } = {},
  ) {
    super(code, message);
    this.name = 'AgentError';
    this.retryable = opts.retryable ?? false;
    this.transient = opts.transient ?? false;
    this.usage = opts.usage ?? [];
  }

  toTaskError(): TaskError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

/** Normalises anything thrown by a tool or the runtime into a user-safe TaskError. */
export function toTaskError(err: unknown): TaskError {
  if (err instanceof AgentError) return err.toTaskError();
  if (err instanceof AppError) {
    // AppErrors raised by shared libraries (e.g. FETCH_BLOCKED from the SSRF guard).
    return { code: err.code, message: err.message, retryable: err.code !== 'FETCH_BLOCKED' };
  }
  return {
    code: 'INTERNAL',
    message: 'Something went wrong while running this step.',
    retryable: true,
  };
}

export function asAgentError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  const te = toTaskError(err);
  return new AgentError(te.code, te.message, { retryable: te.retryable });
}

/** Postgres unique_violation. */
export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === '23505';
}
