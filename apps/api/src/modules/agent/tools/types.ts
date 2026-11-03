import type {
  ApprovalDetails,
  ConnectionProvider,
  ErrorCode,
  Evidence,
  Locale,
  Preferences,
  RiskLevel,
  ToolId,
} from '@jarvis/contracts';
import type { z } from 'zod';
import type { Config } from '../../../config';
import type { Db, DbContext } from '../../../db/pool';
import type { ConnectionRow } from '../../../db/types';
import type { SecretBox } from '../../../lib/crypto';
import type { ModelAdapter, ModelUsage } from '../models/adapter';

export interface AccountInfo {
  userId: string;
  tenantId: string;
  email: string;
  displayName: string;
  locale: Locale;
  timeZone: string;
}

/** Everything a tool may use while executing. Tools never open their own DB context. */
export interface ToolRuntime {
  config: Config;
  db: Db;
  secrets: SecretBox;
  ctx: DbContext;
  taskId: string;
  stepId: string;
  /** tool_executions.idempotency_key of this attempt (deterministic per step/attempt). */
  idempotencyKey: string;
  account: AccountInfo;
  preferences: Preferences;
  /** Active connections only. */
  connections: ReadonlyMap<ConnectionProvider, ConnectionRow>;
  language: Locale;
  /** null = offline (no key, user disabled external models, or budget exhausted). */
  model: ModelAdapter | null;
  /** Streams answer text to clients (ephemeral; not persisted). */
  publishDelta(text: string): Promise<void>;
}

export interface ToolResult {
  /** Full output, stored on the step and available to later steps via {{refs}}. */
  output: Record<string, unknown>;
  /** Display-safe, truncated view for clients. */
  outputPreview: Record<string, unknown>;
  evidence: Evidence[];
  /** Total cost of this execution in micro-USD (model usage included). */
  costMicro: number;
  /** Model calls made by the tool (metered individually). */
  usage?: ModelUsage[];
  /** For assistant.answer: the final answer stored on the task. */
  answer?: string;
}

export interface Verification {
  ok: boolean;
  checks: string[];
}

export interface RiskContext {
  accountEmail: string;
}

export interface CostContext {
  modelAvailable: boolean;
  config: Pick<Config, 'MODEL_FAST' | 'MODEL_BALANCED' | 'MODEL_DEEP'>;
}

export interface ApprovalContext {
  language: Locale;
  stepTitle: string;
  /** Sender shown for email approvals (from the SMTP connection). */
  fromAddress: string | null;
}

export interface ToolDefinition<I> {
  id: ToolId;
  version: string;
  /** Shown to the planner model. */
  description: string;
  /**
   * Input schema. String fields may contain {{stepKey.field}} references at
   * planning time; the same schema validates the resolved input before execution.
   */
  inputSchema: z.ZodType<I>;
  /** Extra planning-time checks on the *planned* input (e.g. no references in recipients). */
  validatePlanned?(input: I): string[];
  /** Output fields later steps may reference. */
  outputFields: readonly string[];
  requiredConnection: ConnectionProvider | null;
  permissions: readonly string[];
  sideEffect: 'none' | 'internal' | 'external';
  /**
   * 'once_per_step': at most one execution per step (idempotency key = step id);
   *   an interrupted external execution is reported as OUTCOME_UNKNOWN, never repeated.
   * 'safe_to_retry': each attempt gets its own key and may be retried automatically.
   */
  idempotency: 'safe_to_retry' | 'once_per_step';
  timeoutMs: number;
  retry: { maxAttempts: number; retryableCodes: readonly ErrorCode[] };
  modelUse: 'none' | 'optional' | 'required';
  riskLevel(input: I, ctx: RiskContext): RiskLevel;
  /** Estimated cost in micro-USD. */
  estimateCostMicro(input: I, ctx: CostContext): number;
  /** Display-safe, redacted view of the input. */
  preview(input: I): Record<string, unknown>;
  approvalDetails(input: I, ctx: ApprovalContext): { details: ApprovalDetails; summary: string };
  /** Recipients of an outbound message, for policy (email.send only). */
  recipients?(input: I): string[];
  execute(input: I, rt: ToolRuntime, signal: AbortSignal): Promise<ToolResult>;
  verify(input: I, output: Record<string, unknown>): Verification;
  /** Security-relevant audit entry written when the execution succeeds (metadata only, never content). */
  audit?(
    input: I,
    output: Record<string, unknown>,
  ): {
    action: string;
    metadata: Record<string, unknown>;
  } | null;
}

/** Registry-erased tool type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any>;

export function evidence(kind: Evidence['kind'], label: string, value: string): Evidence {
  return { kind, label, value, at: new Date().toISOString() };
}
