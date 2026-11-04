import type { ErrorCode } from '@jarvis/contracts';

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  IDEMPOTENCY_MISMATCH: 422,
  INVALID_STATE: 409,
  APPROVAL_EXPIRED: 409,
  APPROVAL_MISMATCH: 409,
  CONNECTION_REQUIRED: 409,
  CONNECTION_FAILED: 422,
  MODEL_NOT_CONFIGURED: 503,
  MODEL_ERROR: 502,
  PLANNER_UNSUPPORTED: 422,
  POLICY_DENIED: 403,
  BUDGET_EXCEEDED: 402,
  TOOL_FAILED: 502,
  TOOL_TIMEOUT: 504,
  OUTCOME_UNKNOWN: 409,
  VERIFICATION_FAILED: 502,
  FETCH_BLOCKED: 422,
  // Phase B (cause in details.reason: contracts ApiErrorReason)
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

/** An error that is safe to show to the user (message must not leak internals). */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`);
export const invalidState = (message: string) => new AppError('INVALID_STATE', message);
