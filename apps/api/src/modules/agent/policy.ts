/**
 * Deterministic policy engine. Pure function of its input — no I/O, no model.
 * The model proposes; this decides. Every decision carries machine-readable
 * reason codes that are stored on the step and shown with approvals.
 *
 * Order of evaluation (first deny wins; approval requirements accumulate):
 *   1. required connection missing/inactive      → deny  CONNECTION_MISSING   (CONNECTION_REQUIRED)
 *   1b. the tool's skill is switched off          → deny  SKILL_DISABLED       (POLICY_DENIED)
 *   2. memory.save while memory is disabled       → deny  MEMORY_DISABLED      (POLICY_DENIED)
 *   2b. memory.save of text derived from content flagged as a suspected
 *       prompt injection                          → deny  UNTRUSTED_MEMORY     (POLICY_DENIED)
 *   3. CRITICAL risk                              → deny  RISK_CRITICAL        (POLICY_DENIED)
 *   4. paid model needed but unavailable / budget is 0
 *                                                 → deny  BUDGET_ZERO | BUDGET_EXHAUSTED (BUDGET_EXCEEDED),
 *                                                         EXTERNAL_MODELS_DISABLED (POLICY_DENIED),
 *                                                         MODEL_UNAVAILABLE (MODEL_NOT_CONFIGURED)
 *   5. risk: LOW → allow; MEDIUM → approval (email to only the account's own
 *      address with autoApproveEmailToSelf → allow, AUTO_APPROVED_SELF);
 *      HIGH → approval, always. schedule.create adds FUTURE_RUNS (never
 *      auto-approved); memory.save of text from an earlier result (a
 *      reference) → approval MEMORY_FROM_CONTENT
 *   6. projected cost above the remaining monthly budget → approval BUDGET_NEAR_LIMIT
 *   6b. projected cost above the skill's per-run limit → approval SKILL_COST_LIMIT
 *   7. external side effect, or outbound request (web.fetch: its URL reaches
 *      another host), consuming content flagged as a suspected prompt
 *      injection → approval UNTRUSTED_CONTENT (overrides auto-approval)
 *
 * Skills (Phase B) can only add a deny (1b) or an approval (6b): the skill
 * fields are computed by assessStep from the static registry and the user's
 * preferences, never by a skill, and no value of them can allow a step, lower
 * its risk or remove an approval (unit-tested).
 *
 * Phase C (docs/architecture/phase-c.md §5):
 *   1. generalised: the exact connection the bound input needs (tool.requires,
 *      else requiredConnection), checked against every non-revoked connection:
 *        none active                        → deny CONNECTION_MISSING       (CONNECTION_REQUIRED)
 *        an OAuth one that expired          → deny CONNECTION_EXPIRED       (CONNECTION_REQUIRED)
 *        active, capability not granted     → deny CONNECTION_SCOPE_MISSING (CONNECTION_REQUIRED)
 *   3b. domain rules (policy-domain.ts): purchases (PURCHASES_DISABLED,
 *       PURCHASE_CURRENCY, PURCHASE_LIMIT deny; else approval PURCHASE),
 *       binding commitments (approval BINDING_COMMITMENT), calendar invitations
 *       (approval RECIPIENT_EXTERNAL) — restrict-only by construction.
 *
 * Phase D (docs/architecture/phase-d.md §5):
 *   3b. phone calls (policy-telephony.ts): TELEPHONY_NOT_CONFIGURED,
 *       CALL_DESTINATION_BLOCKED, DO_NOT_CALL, CALL_OUTSIDE_HOURS, CALL_LIMIT deny;
 *       else approval PHONE_CALL (never auto-approved) + CALL_RECORDING /
 *       CALL_PERSONAL_INFO. The number itself is literal from the user's request
 *       (plan validation, NUMBER_NOT_LITERAL) — never from content or a callee.
 */
import type {
  ConnectionProvider,
  ErrorCode,
  PolicyDecision,
  Preferences,
  RiskLevel,
  TaskErrorReason,
  ToolId,
} from '@jarvis/contracts';
import type { OfflineReason } from './models/router';
import { evaluateDomainRules } from './policy-domain';
import type { CallPolicyFacts } from './policy-telephony';
import type { ConnectionRequirement, ConnectionState, PurchaseFacts } from './tools/types';

export interface PolicyInput {
  toolId: ToolId;
  risk: RiskLevel;
  requiredConnection: ConnectionProvider | null;
  activeConnections: ReadonlySet<ConnectionProvider>;
  preferences: Preferences;
  accountEmail: string;
  /** For email.send: the exact recipients. */
  recipients?: readonly string[];
  sideEffect: 'none' | 'internal' | 'external';
  /**
   * The tool sends requests to URLs taken from its input (web.fetch): even
   * without a side effect, the input leaves JARVIS.
   */
  outbound?: boolean;
  /** Whether the tool needs a paid model ('optional' = uses one when available). */
  modelUse: 'none' | 'optional' | 'required';
  model: { available: boolean; offlineReason: OfflineReason | null };
  projectedCostMicro: number;
  budget: { limitMicro: number; spentMicro: number };
  /** Input derives from content flagged as a suspected prompt injection. */
  untrustedContent?: boolean;
  /**
   * Phase B: whether the skill owning the tool is switched on for this user
   * (from skillOfTool + preferences.skills.disabled; default true).
   */
  skillEnabled?: boolean;
  /** Phase B: the owning skill's per-run cost limit in micro-USD (null/absent = none). */
  skillCostLimitMicro?: number | null;
  /**
   * Phase B: the input takes text from an earlier step's output (a reference),
   * i.e. content rather than the user's own words. memory.save then needs the
   * user's approval of the exact text (MEMORY_FROM_CONTENT).
   */
  fromContent?: boolean;
  /**
   * Phase C: the exact connection this input needs (tool.requires on the
   * bound input); when absent, `requiredConnection` applies.
   */
  requirement?: ConnectionRequirement | null;
  /**
   * Phase C: the tool's connectionOptions (with requiredConnection first, if
   * any). When the input binds no exact requirement, at least one must be
   * satisfied — a tool never runs without a connection it could use.
   */
  connectionOptions?: readonly ConnectionRequirement[];
  /**
   * Phase C: every non-revoked connection with its status and capabilities
   * (from the database via loadAgentContext), so an expired connection is
   * told apart from a missing one. Absent: only `activeConnections` is known.
   */
  connectionStates?: readonly ConnectionState[];
  /**
   * Phase C: money the step commits (tool.purchase on the input) with this
   * month's committed purchases and the limit, in micro-USD.
   */
  purchase?: (PurchaseFacts & { limitMicro: number; spentMicro: number }) | null;
  /** Phase C: invitation recipients (tool.attendees). */
  attendees?: readonly string[];
  /** Phase C: a binding commitment on a site (tool.binding). */
  binding?: boolean;
  /**
   * Phase D: the phone call this step places (tool.call on the exact input) with the
   * server's telephony state and the account's do-not-call list / calls today.
   */
  call?: CallPolicyFacts | null;
}

export interface PolicyResult extends PolicyDecision {
  /** Error code for the task when decision is 'deny'. */
  denyCode: ErrorCode | null;
  /** Phase C: facts of a deny for the TaskError params (e.g. the purchase limit). */
  denyParams?: Record<string, string | number>;
}

const deny = (
  reasons: string[],
  denyCode: ErrorCode,
  denyParams?: Record<string, string | number>,
): PolicyResult => ({
  decision: 'deny',
  reasons,
  denyCode,
  ...(denyParams ? { denyParams } : {}),
});

const OAUTH_PROVIDERS: ReadonlySet<ConnectionProvider> = new Set(['google', 'microsoft']);

/** Rule 1: the connection the step needs — missing, expired, or lacking the capability. */
function connectionDeny(p: PolicyInput): PolicyResult | null {
  const exact: ConnectionRequirement | null =
    p.requirement ??
    (p.connectionOptions?.length
      ? null
      : p.requiredConnection
        ? { provider: p.requiredConnection }
        : null);
  if (exact) return requirementDeny(p, exact);
  if (!p.connectionOptions?.length) return null;
  // No exact requirement could be bound: any one option will do; otherwise the most
  // specific explanation (expired, then a missing capability, then missing).
  const results = p.connectionOptions.map((o) => requirementDeny(p, o));
  if (results.some((r) => r === null)) return null;
  const denied = results as PolicyResult[];
  return (
    denied.find((r) => r.reasons.includes('CONNECTION_EXPIRED')) ??
    denied.find((r) => r.reasons.includes('CONNECTION_SCOPE_MISSING')) ??
    denied[0]!
  );
}

function requirementDeny(p: PolicyInput, req: ConnectionRequirement): PolicyResult | null {
  const params = {
    provider: req.provider,
    ...(req.capability ? { capability: req.capability } : {}),
  };
  if (!p.connectionStates) {
    // Only the active providers are known: a capability cannot be confirmed.
    return p.activeConnections.has(req.provider) && !req.capability
      ? null
      : deny(['CONNECTION_MISSING'], 'CONNECTION_REQUIRED', params);
  }
  const mine = p.connectionStates.filter((c) => c.provider === req.provider);
  const active = mine.find((c) => c.status === 'active');
  if (!active || !p.activeConnections.has(req.provider)) {
    if (OAUTH_PROVIDERS.has(req.provider) && mine.some((c) => c.status === 'expired'))
      return deny(['CONNECTION_EXPIRED'], 'CONNECTION_REQUIRED', params);
    return deny(['CONNECTION_MISSING'], 'CONNECTION_REQUIRED', params);
  }
  if (req.capability && !active.capabilities.includes(req.capability))
    return deny(['CONNECTION_SCOPE_MISSING'], 'CONNECTION_REQUIRED', params);
  return null;
}

export const sameAddress = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export function evaluatePolicy(p: PolicyInput): PolicyResult {
  // 1. Connections (Phase C: the exact requirement; expired and missing scopes told apart)
  const connection = connectionDeny(p);
  if (connection) return connection;
  // 1b. Skill switched off by the user
  if (p.skillEnabled === false) return deny(['SKILL_DISABLED'], 'POLICY_DENIED');
  // 2. Privacy settings
  if (p.toolId === 'memory.save' && !p.preferences.memory.enabled) {
    return deny(['MEMORY_DISABLED'], 'POLICY_DENIED');
  }
  // 2b. Untrusted content can never plant a memory.
  if (p.toolId === 'memory.save' && p.untrustedContent) {
    return deny(['UNTRUSTED_MEMORY'], 'POLICY_DENIED');
  }
  // 3. Risk ceiling for this build
  if (p.risk === 'CRITICAL') return deny(['RISK_CRITICAL'], 'POLICY_DENIED');
  // 3b. Phase C domain rules: purchases, binding commitments, invitations (restrict-only)
  const domain = evaluateDomainRules(p);
  if (domain.deny) return deny(domain.deny.reasons, domain.deny.code, domain.deny.params);

  // 4. Paid model availability
  const usesPaidModel =
    p.modelUse === 'required' || (p.modelUse === 'optional' && p.model.available);
  if (p.modelUse === 'required' && !p.model.available) {
    if (p.budget.limitMicro <= 0) return deny(['BUDGET_ZERO'], 'BUDGET_EXCEEDED');
    switch (p.model.offlineReason) {
      case 'BUDGET_EXHAUSTED':
        return deny(['BUDGET_EXHAUSTED'], 'BUDGET_EXCEEDED');
      case 'USER_DISABLED_EXTERNAL_MODELS':
        return deny(['EXTERNAL_MODELS_DISABLED'], 'POLICY_DENIED');
      default:
        return deny(['MODEL_UNAVAILABLE'], 'MODEL_NOT_CONFIGURED');
    }
  }
  if (usesPaidModel && p.budget.limitMicro <= 0) return deny(['BUDGET_ZERO'], 'BUDGET_EXCEEDED');

  // 5. Risk
  const reasons: string[] = [];
  let needsApproval = false;
  const recipients = p.recipients ?? [];
  const isEmail = p.toolId === 'email.send';
  const allSelf =
    isEmail && recipients.length > 0 && recipients.every((r) => sameAddress(r, p.accountEmail));
  let autoApproved = false;

  switch (p.risk) {
    case 'LOW':
      reasons.push('RISK_LOW');
      break;
    case 'MEDIUM':
      reasons.push('RISK_MEDIUM');
      if (isEmail && allSelf && p.preferences.autonomy.autoApproveEmailToSelf) {
        autoApproved = true;
      } else {
        needsApproval = true;
      }
      break;
    case 'HIGH':
      reasons.push('RISK_HIGH');
      needsApproval = true;
      break;
  }
  if (isEmail) {
    reasons.push(allSelf ? 'RECIPIENT_SELF' : 'RECIPIENT_EXTERNAL');
    if (recipients.length > 3) reasons.push('MANY_RECIPIENTS');
  }
  if (p.toolId === 'schedule.create') {
    // Future side effects: the user always confirms a schedule JARVIS proposes.
    reasons.push('FUTURE_RUNS');
    needsApproval = true;
  }
  if (p.toolId === 'memory.save' && p.fromContent) {
    reasons.push('MEMORY_FROM_CONTENT');
    needsApproval = true;
  }
  // 5b. Phase C domain approvals (PURCHASE, BINDING_COMMITMENT, RECIPIENT_EXTERNAL for invitations)
  for (const r of domain.approval) {
    if (!reasons.includes(r)) reasons.push(r);
    needsApproval = true;
  }
  for (const r of domain.info) if (!reasons.includes(r)) reasons.push(r);

  // 6. Budget headroom
  if (usesPaidModel) {
    const remaining = p.budget.limitMicro - p.budget.spentMicro;
    if (p.projectedCostMicro > remaining) {
      reasons.push('BUDGET_NEAR_LIMIT');
      needsApproval = true;
    }
  }
  // 6b. Skill cost limit
  if (
    typeof p.skillCostLimitMicro === 'number' &&
    p.skillCostLimitMicro >= 0 &&
    p.projectedCostMicro > p.skillCostLimitMicro
  ) {
    reasons.push('SKILL_COST_LIMIT');
    needsApproval = true;
  }

  // 7. Untrusted content feeding an external action or an outbound request
  if (p.untrustedContent && (p.sideEffect === 'external' || p.outbound)) {
    reasons.push('UNTRUSTED_CONTENT');
    needsApproval = true;
  }

  if (needsApproval) return { decision: 'require_approval', reasons, denyCode: null };
  if (autoApproved) reasons.push('AUTO_APPROVED_SELF');
  return { decision: 'allow', reasons, denyCode: null };
}

const DENY_REASONS = [
  'CONNECTION_MISSING',
  // Phase C
  'CONNECTION_EXPIRED',
  'CONNECTION_SCOPE_MISSING',
  'PURCHASES_DISABLED',
  'PURCHASE_LIMIT',
  'PURCHASE_CURRENCY',
  // Phase D
  'TELEPHONY_NOT_CONFIGURED',
  'CALL_DESTINATION_BLOCKED',
  'DO_NOT_CALL',
  'CALL_OUTSIDE_HOURS',
  'CALL_LIMIT',
  'SKILL_DISABLED',
  'MEMORY_DISABLED',
  'UNTRUSTED_MEMORY',
  'RISK_CRITICAL',
  'BUDGET_ZERO',
  'BUDGET_EXHAUSTED',
  'EXTERNAL_MODELS_DISABLED',
] as const satisfies readonly TaskErrorReason[];

/** The TaskError reason of a deny: the policy reason itself, so clients can explain it. */
export function denyReason(code: ErrorCode, reasons: string[]): TaskErrorReason {
  const known = DENY_REASONS.find((r) => reasons.includes(r));
  if (known) return known;
  if (code === 'MODEL_NOT_CONFIGURED' || reasons.includes('MODEL_UNAVAILABLE'))
    return 'MODEL_UNAVAILABLE';
  return 'POLICY_DENIED';
}

/** English developer fallback for a deny (clients show copy for the reason). */
export function denyMessage(code: ErrorCode, reasons: string[], toolTitle: string): string {
  if (reasons.includes('CONNECTION_EXPIRED'))
    return `“${toolTitle}” needs a connection that has expired. Reconnect it in Settings → Connections, then retry.`;
  if (reasons.includes('CONNECTION_SCOPE_MISSING'))
    return `“${toolTitle}” needs a permission the connection does not grant. Reconnect it and allow that permission, then retry.`;
  if (reasons.includes('PURCHASES_DISABLED'))
    return 'Purchases are turned off: your monthly purchase limit is $0. Set a limit in Settings to allow them.';
  if (reasons.includes('PURCHASE_LIMIT'))
    return 'This purchase would go over your monthly purchase limit, so JARVIS will not make it.';
  if (reasons.includes('PURCHASE_CURRENCY'))
    return 'This purchase is not in US dollars, the currency of your purchase limit, so JARVIS will not make it.';
  if (reasons.includes('TELEPHONY_NOT_CONFIGURED'))
    return 'Phone calls are not set up on this server, so JARVIS cannot place this call.';
  if (reasons.includes('CALL_DESTINATION_BLOCKED'))
    return 'JARVIS does not call this number: premium-rate and shared-cost numbers, and countries this server does not call, are blocked.';
  if (reasons.includes('DO_NOT_CALL'))
    return 'This number asked not to be called again, so JARVIS will not call it.';
  if (reasons.includes('CALL_OUTSIDE_HOURS'))
    return 'It is outside the hours in which JARVIS places calls in the callee’s time zone. Retry within those hours.';
  if (reasons.includes('CALL_LIMIT'))
    return 'JARVIS has placed the maximum number of calls for today. Retry tomorrow.';
  if (reasons.includes('CONNECTION_MISSING'))
    return `“${toolTitle}” needs a connection that is not set up or not active. Connect it in Settings → Connections, then retry.`;
  if (reasons.includes('SKILL_DISABLED'))
    return `“${toolTitle}” belongs to a skill you switched off in Settings → Skills.`;
  if (reasons.includes('MEMORY_DISABLED'))
    return 'Memory is turned off in your privacy settings, so JARVIS will not save this.';
  if (reasons.includes('UNTRUSTED_MEMORY'))
    return 'The text to remember came from content that tried to give instructions to AI assistants, so JARVIS will not save it.';
  if (reasons.includes('RISK_CRITICAL'))
    return 'This action is classified as critical risk and is not allowed in this version of JARVIS.';
  if (reasons.includes('BUDGET_ZERO'))
    return 'Your monthly AI budget is set to $0, so this step cannot use an AI model.';
  if (reasons.includes('BUDGET_EXHAUSTED'))
    return 'Your monthly AI budget is used up, so this step cannot use an AI model until next month or until you raise the budget.';
  if (reasons.includes('EXTERNAL_MODELS_DISABLED'))
    return 'External AI models are turned off in your privacy settings, and this step needs one.';
  if (code === 'MODEL_NOT_CONFIGURED')
    return 'This step needs an AI model, and none is configured on this server.';
  return `The policy engine did not allow “${toolTitle}”.`;
}
