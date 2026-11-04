/** Glue between a step, its tool and the policy engine (used at plan and execution time). */
import {
  RISK_ORDER,
  type RiskLevel,
  type TaskError,
  type UntrustedSource,
} from '@jarvis/contracts';
import type { Config } from '../../config';
import type { StepRow } from '../../db/types';
import { localTimeOfDay } from '../../lib/period';
import { checkDestination, maskPhoneNumber, phoneHashKey, phoneNumberHash } from '../../lib/phone';
import { redact } from '../../lib/redact';
import type { AgentContext } from './context';
import { denyMessage, denyReason, evaluatePolicy, type PolicyResult } from './policy';
import type { CallPolicyFacts } from './policy-telephony';
import { skillOfTool } from './skills/registry';
import { findRefs } from './templates';
import { getTool } from './tools/registry';
import type { AnyTool, CallFacts, CostContext } from './tools/types';

export interface StepAssessment {
  risk: RiskLevel;
  policy: PolicyResult;
  preview: Record<string, unknown>;
  estimateMicro: number;
}

/**
 * The skill fields of the policy input, from the static registry and the
 * user's preferences only (personal-memory's switch is memory.enabled, which
 * the policy checks as MEMORY_DISABLED).
 */
export function skillPolicy(
  tool: AnyTool,
  agent: Pick<AgentContext, 'preferences'>,
): { skillEnabled: boolean; skillCostLimitMicro: number | null } {
  const skill = skillOfTool(tool.id);
  const disabled = new Set(agent.preferences.skills?.disabled ?? []);
  return {
    skillEnabled: !(skill.canToggle && skill.id !== 'personal-memory' && disabled.has(skill.id)),
    skillCostLimitMicro: skill.maxCostPerRunMicroUsd,
  };
}

/** What an unreadable call declaration counts as: a call to no valid number (denied). */
const UNREADABLE_CALL: CallFacts = {
  to: '',
  calleeTimeZone: null,
  purpose: 'message',
  recording: 'required',
  sharedDetails: 1,
  allowTransfer: true,
};

const hashKeys = new Map<string, Buffer>();
/** The phone-number hash key of this server's secret (derived once per process). */
function hashKeyOf(config: Pick<Config, 'SECRET_ENCRYPTION_KEY'>): Buffer {
  let key = hashKeys.get(config.SECRET_ENCRYPTION_KEY);
  if (!key) {
    key = phoneHashKey(config.SECRET_ENCRYPTION_KEY);
    hashKeys.set(config.SECRET_ENCRYPTION_KEY, key);
  }
  return key;
}

/**
 * Phase D: the Policy Engine's facts of a call step, from the tool's declaration on the exact
 * input and the account's telephony context. Missing context = not configured (deny);
 * an unreadable declaration = an invalid number (deny): never an allow.
 */
export function callPolicyFacts(
  facts: CallFacts,
  agent: Pick<AgentContext, 'telephony' | 'account'>,
  config: Pick<Config, 'SECRET_ENCRYPTION_KEY'>,
): CallPolicyFacts {
  const t = agent.telephony;
  const to = typeof facts.to === 'string' ? facts.to : '';
  const timeZone = facts.calleeTimeZone ?? agent.account.timeZone;
  const hours = { ...(t?.allowedHours ?? { start: '08:00', end: '20:00' }), timeZone };
  const local = localTimeOfDay(t?.now ?? new Date(), timeZone);
  return {
    configured: t?.configured === true,
    to,
    masked: to ? maskPhoneNumber(to) : '',
    destination: to
      ? checkDestination(to, t?.allowedCountries ?? new Set())
      : { ok: false, reason: 'invalid', country: null },
    doNotCall: to
      ? (t?.doNotCall.has(phoneNumberHash(hashKeyOf(config), to).toString('hex')) ?? false)
      : false,
    withinHours: local === null ? null : local >= hours.start && local < hours.end,
    hours,
    callsToday: t?.callsToday ?? 0,
    maxPerDay: t?.maxPerDay ?? 0,
    recording: facts.recording !== 'off',
    sharesPersonalInfo: facts.sharedDetails > 0,
  };
}

/**
 * Plan and execution time share this: `input` is the planned input (with
 * references) at plan time and the resolved input at execution time, so
 * `fromContent` (the input takes text from earlier steps) must come from the
 * planned input; it defaults to "input has references".
 */
export function assessStep(
  tool: AnyTool,
  input: Record<string, unknown>,
  agent: AgentContext,
  config: Config,
  opts: {
    untrustedContent?: boolean;
    extraSpentMicro?: number;
    fromContent?: boolean;
    /** Files of the task's conversation (cost estimates of document.analyze). */
    attachments?: CostContext['attachments'];
  } = {},
): StepAssessment {
  const modelAvailable = agent.route.mode === 'model';
  const risk = tool.riskLevel(input, { accountEmail: agent.account.email });
  const estimateMicro = tool.estimateCostMicro(input, {
    modelAvailable,
    config,
    attachments: opts.attachments,
  });
  // Tool declarations are facts about the input; a hook that throws on an
  // unexpected shape yields no fact (and never an allow): see each default.
  const fact = <T>(f: () => T, fallback: T): T => {
    try {
      return f();
    } catch {
      return fallback;
    }
  };
  const recipients = fact<string[] | undefined>(() => tool.recipients?.(input), undefined);
  // Phase C facts (docs/architecture/phase-c.md §5).
  const requirement = tool.requires ? fact(() => tool.requires!(input), null) : null;
  const purchaseFacts = tool.purchase
    ? fact(() => tool.purchase!(input), { amountMicro: null, currency: null })
    : null;
  const purchase = purchaseFacts
    ? {
        ...purchaseFacts,
        limitMicro: agent.purchases?.limitMicro ?? 0,
        spentMicro: agent.purchases?.spentMicro ?? 0,
      }
    : null;
  // An unreadable attendee list must not hide invitations: treat it as external.
  const attendees = tool.attendees ? fact(() => tool.attendees!(input), ['?']) : undefined;
  const binding = tool.binding ? fact(() => tool.binding!(input), true) : false;
  // Phase D: a call's facts. A declaration that throws becomes a call to an invalid number
  // (deny); `null` means this input places no call.
  const callFacts = tool.call ? fact(() => tool.call!(input), UNREADABLE_CALL) : null;
  const call = callFacts ? callPolicyFacts(callFacts, agent, config) : null;
  const policy = evaluatePolicy({
    toolId: tool.id,
    risk,
    requiredConnection: tool.requiredConnection,
    activeConnections: new Set(agent.connections.keys()),
    preferences: agent.preferences,
    accountEmail: agent.account.email,
    recipients,
    sideEffect: tool.sideEffect,
    outbound: tool.urls !== undefined || tool.outbound === true,
    requirement,
    connectionOptions: tool.connectionOptions
      ? [
          ...(tool.requiredConnection ? [{ provider: tool.requiredConnection }] : []),
          ...tool.connectionOptions,
        ]
      : undefined,
    connectionStates: agent.connectionStates,
    purchase,
    attendees,
    binding,
    call,
    modelUse: tool.modelUse,
    model: { available: modelAvailable, offlineReason: agent.route.reason },
    projectedCostMicro: estimateMicro,
    budget: {
      limitMicro: agent.budget.limitMicro,
      spentMicro: agent.budget.spentMicro + (opts.extraSpentMicro ?? 0),
    },
    untrustedContent: opts.untrustedContent ?? false,
    ...skillPolicy(tool, agent),
    fromContent: opts.fromContent ?? findRefs(input).length > 0,
  });
  return { risk, policy, preview: redact(tool.preview(input)), estimateMicro };
}

/** The TaskError of a denied step (shared by planning and execution). */
export function denyError(
  tool: AnyTool,
  stepTitle: string,
  policy: PolicyResult,
): TaskError & { code: NonNullable<PolicyResult['denyCode']> } {
  const code = policy.denyCode ?? 'POLICY_DENIED';
  const params: Record<string, string | number> = { step: stepTitle, ...(policy.denyParams ?? {}) };
  if (policy.reasons.includes('SKILL_DISABLED')) params.skill = skillOfTool(tool.id).id;
  return {
    code,
    message: denyMessage(code, policy.reasons, stepTitle),
    retryable: true,
    reason: denyReason(code, policy.reasons),
    params,
  };
}

export function maxRisk(levels: RiskLevel[]): RiskLevel {
  return levels.reduce<RiskLevel>((a, b) => (RISK_ORDER[b] > RISK_ORDER[a] ? b : a), 'LOW');
}

/**
 * Whether `target`'s input derives (directly or transitively) from output
 * flagged as a suspected prompt injection.
 */
export function isTainted(steps: StepRow[], target: StepRow): boolean {
  const tainted = new Map<string, boolean>();
  for (const s of steps) {
    if (s.position >= target.position) break;
    const flagged = (s.output as Record<string, unknown> | null)?.suspectedInjection === true;
    const inherited = findRefs(s.input).some((r) => tainted.get(r.stepKey));
    tainted.set(s.step_key, flagged || inherited);
  }
  return findRefs(target.input).some((r) => tainted.get(r.stepKey));
}

type Out = Record<string, unknown> | null;

/**
 * What the policy's UNTRUSTED_CONTENT is about, for the approval: the page
 * the flagged content came from, how many sentences the summary left out,
 * and the detector's signal ids. Walks the steps `target` depends on
 * (transitively); null when none of them was flagged. Never includes the
 * flagged text itself.
 */
export function untrustedSource(steps: StepRow[], target: StepRow): UntrustedSource | null {
  const byKey = new Map(steps.map((s) => [s.step_key, s]));
  const seen = new Set<string>();
  const deps: StepRow[] = [];
  const visit = (s: StepRow) => {
    for (const ref of findRefs(s.input)) {
      if (seen.has(ref.stepKey)) continue;
      seen.add(ref.stepKey);
      const dep = byKey.get(ref.stepKey);
      if (!dep || dep.position >= target.position) continue;
      deps.push(dep);
      visit(dep);
    }
  };
  visit(target);
  const flagged = deps.filter((s) => (s.output as Out)?.suspectedInjection === true);
  if (flagged.length === 0) return null;

  let host: string | null = null;
  for (const s of [...deps].sort((a, b) => a.position - b.position)) {
    // A fetched page, or the page an earlier (recalled) result was made from.
    const url =
      s.tool_id === 'web.fetch'
        ? (s.output as Out)?.finalUrl
        : s.tool_id === 'conversation.recall'
          ? (s.output as Out)?.sourceUrl
          : null;
    if (typeof url !== 'string') {
      // Phase C: tools that read other sources say where flagged content came from.
      const tool = getTool(s.tool_id);
      const declared = tool?.untrustedHost?.((s.output as Out) ?? {}) ?? null;
      if (declared) {
        host = declared;
        break;
      }
      continue;
    }
    try {
      host = new URL(url).host;
      break;
    } catch {
      // Not a URL: keep looking.
    }
  }
  let excluded: number | null = null;
  for (const s of deps) {
    const n = (s.output as Out)?.excludedSentences;
    if (
      (s.tool_id === 'text.summarize' || s.tool_id === 'document.analyze') &&
      typeof n === 'number'
    )
      excluded = (excluded ?? 0) + n;
  }
  const signals = new Set<string>();
  for (const s of flagged) {
    const list = (s.output as Out)?.injectionSignals;
    if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') signals.add(id);
  }
  return { host, excludedSentences: excluded, signals: [...signals].sort() };
}
