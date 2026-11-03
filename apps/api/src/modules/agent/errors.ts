import type { ErrorCode, TaskError, TaskErrorReason } from '@jarvis/contracts';
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
 * - `reason` + `params`: which failure of that code it is, as data. Clients
 *   show copy for code / reason / params; `message` is an English developer
 *   fallback and never needs to be translated.
 */
export type ErrorParams = Record<string, string | number>;

export interface AgentErrorOptions {
  retryable?: boolean;
  transient?: boolean;
  usage?: ModelUsage[];
  reason?: TaskErrorReason;
  params?: ErrorParams;
}

export class AgentError extends AppError {
  readonly retryable: boolean;
  readonly transient: boolean;
  readonly usage: ModelUsage[];
  readonly reason: TaskErrorReason | undefined;
  readonly params: ErrorParams | undefined;

  constructor(code: ErrorCode, message: string, opts: AgentErrorOptions = {}) {
    super(code, message);
    this.name = 'AgentError';
    this.retryable = opts.retryable ?? false;
    this.transient = opts.transient ?? false;
    this.usage = opts.usage ?? [];
    this.reason = opts.reason;
    this.params = opts.params;
  }

  toTaskError(): TaskError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.params && Object.keys(this.params).length ? { params: this.params } : {}),
    };
  }
}

/** Normalises anything thrown by a tool or the runtime into a user-safe TaskError. */
export function toTaskError(err: unknown): TaskError {
  if (err instanceof AgentError) return err.toTaskError();
  if (err instanceof AppError) {
    // AppErrors raised by shared libraries (e.g. FETCH_BLOCKED from the SSRF guard).
    return err.code === 'FETCH_BLOCKED'
      ? { code: err.code, message: err.message, retryable: false, reason: 'PRIVATE_ADDRESS' }
      : { code: err.code, message: err.message, retryable: true };
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
  return new AgentError(te.code, te.message, {
    retryable: te.retryable,
    reason: te.reason,
    params: te.params,
  });
}

/** Postgres unique_violation. */
export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === '23505';
}
