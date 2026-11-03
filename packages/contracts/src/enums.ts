import { z } from 'zod';

export const Locale = z.enum(['en', 'de', 'ar']);
export type Locale = z.infer<typeof Locale>;
export const RTL_LOCALES: readonly Locale[] = ['ar'];

export const ThemePreference = z.enum(['system', 'light', 'dark']);
export type ThemePreference = z.infer<typeof ThemePreference>;

export const Platform = z.enum(['web', 'ios', 'android', 'macos']);
export type Platform = z.infer<typeof Platform>;

export const Role = z.enum(['owner', 'member', 'platform_admin']);
export type Role = z.infer<typeof Role>;

/** Risk classification enforced by the deterministic Policy Engine (never by the model). */
export const RiskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type RiskLevel = z.infer<typeof RiskLevel>;
export const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export const TaskStatus = z.enum([
  'QUEUED',
  'PLANNING',
  'AWAITING_APPROVAL',
  'RUNNING',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const StepStatus = z.enum([
  'PENDING',
  'AWAITING_APPROVAL',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
  'BLOCKED',
]);
export type StepStatus = z.infer<typeof StepStatus>;

export const ApprovalStatus = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
  'SUPERSEDED',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const TaskSource = z.enum(['text', 'voice', 'schedule', 'api']);
export type TaskSource = z.infer<typeof TaskSource>;

/** Tools implemented in this build. The backend tool registry is authoritative. */
export const ToolId = z.enum([
  'web.fetch',
  'text.summarize',
  'email.send',
  'memory.save',
  'assistant.answer',
]);
export type ToolId = z.infer<typeof ToolId>;

export const ConnectionProvider = z.enum(['web', 'smtp']);
export type ConnectionProvider = z.infer<typeof ConnectionProvider>;

export const ConnectionStatus = z.enum(['active', 'error', 'expired', 'revoked']);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const MemoryKind = z.enum(['preference', 'fact']);
export type MemoryKind = z.infer<typeof MemoryKind>;

export const NotificationKind = z.enum([
  'approval_requested',
  'task_completed',
  'task_failed',
  'connection_error',
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const ErrorCode = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'RATE_LIMITED',
  'IDEMPOTENCY_MISMATCH',
  'INVALID_STATE',
  'APPROVAL_EXPIRED',
  'APPROVAL_MISMATCH',
  'CONNECTION_REQUIRED',
  'CONNECTION_FAILED',
  'MODEL_NOT_CONFIGURED',
  'MODEL_ERROR',
  'PLANNER_UNSUPPORTED',
  'POLICY_DENIED',
  'BUDGET_EXCEEDED',
  'TOOL_FAILED',
  'TOOL_TIMEOUT',
  'OUTCOME_UNKNOWN',
  'VERIFICATION_FAILED',
  'FETCH_BLOCKED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;
