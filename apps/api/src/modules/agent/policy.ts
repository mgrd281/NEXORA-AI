/**
 * Deterministic policy engine. Pure function of its input — no I/O, no model.
 * The model proposes; this decides. Every decision carries machine-readable
 * reason codes that are stored on the step and shown with approvals.
 *
 * Order of evaluation (first deny wins; approval requirements accumulate):
 *   1. required connection missing/inactive      → deny  CONNECTION_MISSING   (CONNECTION_REQUIRED)
 *   2. memory.save while memory is disabled       → deny  MEMORY_DISABLED      (POLICY_DENIED)
 *   3. CRITICAL risk                              → deny  RISK_CRITICAL        (POLICY_DENIED)
 *   4. paid model needed but unavailable / budget is 0
 *                                                 → deny  BUDGET_ZERO | BUDGET_EXHAUSTED (BUDGET_EXCEEDED),
 *                                                         EXTERNAL_MODELS_DISABLED (POLICY_DENIED),
 *                                                         MODEL_UNAVAILABLE (MODEL_NOT_CONFIGURED)
 *   5. risk: LOW → allow; MEDIUM → approval (email to only the account's own
 *      address with autoApproveEmailToSelf → allow, AUTO_APPROVED_SELF);
 *      HIGH → approval, always
 *   6. projected cost above the remaining monthly budget → approval BUDGET_NEAR_LIMIT
 *   7. external side effect consuming content flagged as a suspected prompt
 *      injection → approval UNTRUSTED_CONTENT (overrides auto-approval)
 */
import type {
  ConnectionProvider,
  ErrorCode,
  PolicyDecision,
  Preferences,
  RiskLevel,
  ToolId,
} from '@jarvis/contracts';
import type { OfflineReason } from './models/router';

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
  /** Whether the tool needs a paid model ('optional' = uses one when available). */
  modelUse: 'none' | 'optional' | 'required';
  model: { available: boolean; offlineReason: OfflineReason | null };
  projectedCostMicro: number;
  budget: { limitMicro: number; spentMicro: number };
  /** Input derives from content flagged as a suspected prompt injection. */
  untrustedContent?: boolean;
}

export interface PolicyResult extends PolicyDecision {
  /** Error code for the task when decision is 'deny'. */
  denyCode: ErrorCode | null;
}

const deny = (reasons: string[], denyCode: ErrorCode): PolicyResult => ({
  decision: 'deny',
  reasons,
  denyCode,
});

export const sameAddress = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export function evaluatePolicy(p: PolicyInput): PolicyResult {
  // 1. Connections
  if (p.requiredConnection && !p.activeConnections.has(p.requiredConnection)) {
    return deny(['CONNECTION_MISSING'], 'CONNECTION_REQUIRED');
  }
  // 2. Privacy settings
  if (p.toolId === 'memory.save' && !p.preferences.memory.enabled) {
    return deny(['MEMORY_DISABLED'], 'POLICY_DENIED');
  }
  // 3. Risk ceiling for this build
  if (p.risk === 'CRITICAL') return deny(['RISK_CRITICAL'], 'POLICY_DENIED');

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

  // 6. Budget headroom
  if (usesPaidModel) {
    const remaining = p.budget.limitMicro - p.budget.spentMicro;
    if (p.projectedCostMicro > remaining) {
      reasons.push('BUDGET_NEAR_LIMIT');
      needsApproval = true;
    }
  }

  // 7. Untrusted content feeding an external action
  if (p.untrustedContent && p.sideEffect === 'external') {
    reasons.push('UNTRUSTED_CONTENT');
    needsApproval = true;
  }

  if (needsApproval) return { decision: 'require_approval', reasons, denyCode: null };
  if (autoApproved) reasons.push('AUTO_APPROVED_SELF');
  return { decision: 'allow', reasons, denyCode: null };
}

export function denyMessage(code: ErrorCode, reasons: string[], toolTitle: string): string {
  if (reasons.includes('CONNECTION_MISSING'))
    return `“${toolTitle}” needs a connection that is not set up or not active. Connect it in Settings → Connections, then retry.`;
  if (reasons.includes('MEMORY_DISABLED'))
    return 'Memory is turned off in your privacy settings, so JARVIS will not save this.';
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
