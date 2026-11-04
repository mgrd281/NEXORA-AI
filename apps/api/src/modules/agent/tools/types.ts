import type {
  ApprovalDetails,
  CallPurpose,
  ConnectionCapability,
  ConnectionProvider,
  ConnectionStatus,
  ErrorCode,
  Evidence,
  EvidenceCode,
  Locale,
  Preferences,
  RecordingMode,
  RiskLevel,
  ServerMessage,
  ToolId,
  VerificationCheckKey,
} from '@jarvis/contracts';
import type { z } from 'zod';
import type { Config } from '../../../config';
import type { Db, DbContext } from '../../../db/pool';
import type { AttachmentRow, ConnectionRow } from '../../../db/types';
import type { SecretBox } from '../../../lib/crypto';
import type { ObjectStorage } from '../../storage/types';
import type { PriorTurn } from '../conversation-context';
import { msg, render } from '../i18n';
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
  /** Phase B: attachment storage (null when STORAGE_DRIVER is 'none'). */
  storage: ObjectStorage | null;
  /** Phase B: the conversation this task belongs to. */
  conversationId: string;
  /** Phase B: files of this task's conversation (RLS-visible rows, as of the step). */
  attachments: readonly AttachmentRow[];
  /** Phase B: earlier turns of the conversation (bounded; results are untrusted data). */
  conversation: readonly PriorTurn[];
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

/** One verification result: a check key + params for clients, `text` as the English fallback. */
export interface CheckResult {
  key: VerificationCheckKey;
  params: Record<string, string | number>;
  text: string;
}

export interface Verification {
  ok: boolean;
  checks: CheckResult[];
}

export function check(
  key: VerificationCheckKey,
  text: string,
  params: Record<string, string | number> = {},
): CheckResult {
  return { key, params, text };
}

export interface RiskContext {
  accountEmail: string;
}

export interface CostContext {
  modelAvailable: boolean;
  config: Pick<Config, 'MODEL_FAST' | 'MODEL_BALANCED' | 'MODEL_DEEP'>;
  /** Phase B: files of the task's conversation (document.analyze sizes its estimate by them). */
  attachments?: readonly { id: string; sizeBytes: number; textChars: number | null }[];
}

/**
 * Phase C: a connection a step needs — a provider, and optionally a capability
 * that connection must grant (OAuth). The Policy Engine checks it on the exact
 * (bound) input: missing → CONNECTION_MISSING, expired → CONNECTION_EXPIRED,
 * capability not granted → CONNECTION_SCOPE_MISSING.
 */
export interface ConnectionRequirement {
  provider: ConnectionProvider;
  capability?: ConnectionCapability;
}

/** Phase C: one of the user's connections as planning and policy see it (no secrets). */
export interface ConnectionState {
  connectionId: string;
  provider: ConnectionProvider;
  status: ConnectionStatus;
  /** Granted capabilities (OAuth); [] for SMTP and web. */
  capabilities: readonly ConnectionCapability[];
  accountIdentifier: string | null;
}

/** Phase C: what `bind` may use to fill deterministic defaults into a planned input. */
export interface BindContext {
  /** Every non-revoked connection, in a fixed order (provider, then creation). */
  connections: readonly ConnectionState[];
  accountEmail: string;
  /** The account's display name (forms that ask for the user's own name). */
  ownName?: string | null;
  timeZone: string;
  /**
   * Phase D: an AI model can be used now (the planning route). phone.call binds its dialog
   * mode from it: 'model' only when available, else 'scripted' — fixed in the approved input.
   */
  modelAvailable?: boolean;
  /** Phase D: the account's language (the default call language when the user names none). */
  locale?: Locale;
}

/**
 * Phase D: the facts of a phone call a step would place (tool.call on the exact input).
 * The Policy Engine decides with them and the server's / account's telephony state
 * (policy-telephony.ts): destination, do-not-call, calling hours, daily limit, and the
 * approval reasons PHONE_CALL, CALL_RECORDING, CALL_PERSONAL_INFO.
 */
export interface CallFacts {
  /** E.164 as it would be dialled. */
  to: string;
  /** The callee's zone (allowed hours); null = the account's zone. */
  calleeTimeZone: string | null;
  purpose: CallPurpose;
  recording: RecordingMode;
  /** Personal details the approval lets JARVIS share (count). */
  sharedDetails: number;
  /** The call may transfer the callee to the account's own number. */
  allowTransfer: boolean;
}

/**
 * Phase C: money a step commits (shop.checkout, a paid booking). Null fields
 * are not known yet (planning time: the input still has {{refs}}); the
 * execution-time policy decides on the resolved input.
 */
export interface PurchaseFacts {
  amountMicro: number | null;
  currency: string | null;
}

export interface ApprovalContext {
  language: Locale;
  stepTitle: string;
  /** The step title as a message, when the server wrote it (offline planner). */
  stepTitleMessage: ServerMessage | null;
  /** Sender shown for email approvals (from the SMTP connection). */
  fromAddress: string | null;
  /** Phase B: the input takes text from earlier steps' outputs (content, not the user's words). */
  fromContent?: boolean;
  /** Phase B: the earlier task a conversation.recall step this one depends on reads. */
  recalledTaskId?: string | null;
  /** Phase B: when the approval is requested (schedule previews). */
  now?: Date;
  /** Phase C: the account (calendar approvals show times in its zone by default). */
  account?: { email: string; timeZone: string };
  /** Phase C: the address of each connected account (the sender / calendar shown in approvals). */
  accounts?: Partial<Record<ConnectionProvider, string | null>>;
  /** Phase C: this month's committed purchases and the limit, in micro-USD (purchase approvals). */
  purchases?: { limitMicro: number; spentMicro: number };
  /**
   * Phase C: the host a supported site's recipe loads on this server (its first enabled origin),
   * or null when the recipe is not enabled here. Approvals show the real host, not a label.
   */
  siteHost?: (siteId: string) => string | null;
  /**
   * Phase D: what a phone-call approval shows besides the input: who JARVIS calls for, the
   * caller id the callee sees, the account's own verified number (masked) a callee may be put
   * through to, the calling window and the cost basis.
   */
  telephony?: {
    configured: boolean;
    callerId: string | null;
    onBehalfOf: string;
    transferTo: string | null;
    allowedHours: { start: string; end: string };
    pricePerMinuteMicroUsd: number | null;
    maxCallSeconds: number;
  };
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
  /**
   * Phase B: references in this tool's input may only point at steps of these
   * tools (memory.save: only conversation.recall, so a memory is either the
   * user's own words or an earlier result the user approves verbatim).
   */
  allowedRefTools?: readonly ToolId[];
  /**
   * Phase B: ids from the deterministic planning context this input names
   * (conversation.recall: an earlier task; document.analyze: an attachment).
   * validatePlan requires each to be a literal id from that context.
   */
  contextIds?(input: I): { kind: 'task' | 'attachment'; id: unknown }[];
  /**
   * Phase B: text that becomes a future request (schedule.create): every email
   * address and link inside must be written in one of the user's requests.
   */
  literalTexts?(input: I): string[];
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
  /** `summaryMessage` is `summary` as a message key, so clients can render it in their locale. */
  approvalDetails(
    input: I,
    ctx: ApprovalContext,
  ): { details: ApprovalDetails; summary: string; summaryMessage: ServerMessage | null };
  /** Recipients of an outbound message, for policy (email.send only). */
  recipients?(input: I): string[];
  /**
   * URLs the tool sends requests to (web.fetch only). Even a read-only request
   * carries its URL to another host, so plan validation requires each to be on
   * a site written in the request, and the policy treats the step as outbound
   * (input derived from suspected prompt injection needs approval).
   */
  urls?(input: I): string[];
  /* ---------------------------------------------------------------- */
  /* Phase C hooks (docs/architecture/phase-c.md §4). All optional:    */
  /* a tool declares facts; the Policy Engine and the planner decide.  */
  /* ---------------------------------------------------------------- */

  /**
   * Connections the tool can work with (any one): the planner offers it only
   * when one of them is active (availableTools) and skills report availability
   * from them. Absent: `requiredConnection` alone.
   */
  connectionOptions?: readonly ConnectionRequirement[];
  /**
   * The exact connection this (bound) input uses — e.g. email.send `via`, a
   * calendar tool's `provider`. Overrides `requiredConnection` for the policy.
   * Must be a pure function of the input.
   */
  requires?(input: I): ConnectionRequirement | null;
  /**
   * Fills deterministic defaults into the planned input before it is
   * validated and stored (e.g. which connected account sends), so the
   * approval and its action hash bind the exact account. Never invents
   * content, recipients, URLs or amounts; returns the input unchanged when
   * there is nothing to choose.
   */
  bind?(input: I, ctx: BindContext): I;
  /**
   * People other than the account who receive an invitation / update
   * (calendar tools). Plan validation requires each to be literal in the
   * user's requests (or the owner); the policy adds RECIPIENT_EXTERNAL.
   */
  attendees?(input: I): string[];
  /** Money the step commits (policy: PURCHASES_DISABLED / PURCHASE_LIMIT / PURCHASE_CURRENCY / PURCHASE). */
  purchase?(input: I): PurchaseFacts | null;
  /** The step makes a binding commitment on a site (policy: approval BINDING_COMMITMENT). */
  binding?(input: I): boolean;
  /**
   * The step sends requests to a site (browser tools): untrusted content
   * feeding its input needs approval (UNTRUSTED_CONTENT), as for web.fetch.
   */
  outbound?: boolean;
  /** Runs in the isolated browser agent: hidden from the planner while none is available. */
  runsInBrowser?: boolean;
  /**
   * The output field holding this tool's text result: JARVIS's answer message,
   * the result line of read-only tasks and conversation.recall use it.
   */
  resultTextField?: string;
  /** The one-sentence result line of a successful step with a side effect (e.g. result.eventCreated). */
  resultLine?(input: I, output: Record<string, unknown>): ServerMessage | null;
  /** A short fact for the model-written result line (no secrets; content truncated). */
  resultFact?(input: I, output: Record<string, unknown>): string;
  /** The host flagged content came from, for UNTRUSTED_CONTENT approvals (a page, a sender's domain). */
  untrustedHost?(output: Record<string, unknown>): string | null;

  /* ---------------------------------------------------------------- */
  /* Phase D hooks (docs/architecture/phase-d.md §4). All optional.    */
  /* ---------------------------------------------------------------- */

  /**
   * Phone numbers the tool dials (E.164). Plan validation requires each to be written in the
   * user's own requests (normalised with lib/phone.ts; NUMBER_NOT_LITERAL otherwise) — never
   * from results, pages, mail, memories or anything a callee said.
   */
  phoneNumbers?(input: I): string[];
  /** The call this input would place (policy-telephony.ts decides on it). */
  call?(input: I): CallFacts | null;
  /** Needs the telephony gateway: hidden from the planner while none is configured. */
  needsTelephony?: boolean;

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

/**
 * A piece of evidence. `label` / `value` are the protocol-level fallback;
 * `code` + `params` carry the same facts for clients to label in their locale.
 */
export function evidence(
  kind: Evidence['kind'],
  label: string,
  value: string,
  code?: EvidenceCode,
  params?: Record<string, string | number>,
): Evidence {
  return {
    kind,
    label,
    value,
    at: new Date().toISOString(),
    ...(code ? { code, params: params ?? {} } : {}),
  };
}

/** "Run “<step>” (<tool>)." — the approval summary of tools without a specific sentence. */
export function genericApprovalSummary(
  ctx: ApprovalContext,
  tool: ToolId,
): { summary: string; summaryMessage: ServerMessage } {
  const summaryMessage = msg('approval.generic', {
    title: ctx.stepTitleMessage ?? ctx.stepTitle,
    tool,
  });
  return { summary: render(ctx.language, summaryMessage), summaryMessage };
}
