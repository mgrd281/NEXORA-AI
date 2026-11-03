/** Glue between a step, its tool and the policy engine (used at plan and execution time). */
import { RISK_ORDER, type RiskLevel, type UntrustedSource } from '@jarvis/contracts';
import type { Config } from '../../config';
import type { StepRow } from '../../db/types';
import { redact } from '../../lib/redact';
import type { AgentContext } from './context';
import { evaluatePolicy, type PolicyResult } from './policy';
import { findRefs } from './templates';
import type { AnyTool } from './tools/types';

export interface StepAssessment {
  risk: RiskLevel;
  policy: PolicyResult;
  preview: Record<string, unknown>;
  estimateMicro: number;
}

export function assessStep(
  tool: AnyTool,
  input: Record<string, unknown>,
  agent: AgentContext,
  config: Config,
  opts: { untrustedContent?: boolean; extraSpentMicro?: number } = {},
): StepAssessment {
  const modelAvailable = agent.route.mode === 'model';
  const risk = tool.riskLevel(input, { accountEmail: agent.account.email });
  const estimateMicro = tool.estimateCostMicro(input, { modelAvailable, config });
  let recipients: string[] | undefined;
  try {
    recipients = tool.recipients?.(input);
  } catch {
    recipients = undefined;
  }
  const policy = evaluatePolicy({
    toolId: tool.id,
    risk,
    requiredConnection: tool.requiredConnection,
    activeConnections: new Set(agent.connections.keys()),
    preferences: agent.preferences,
    accountEmail: agent.account.email,
    recipients,
    sideEffect: tool.sideEffect,
    modelUse: tool.modelUse,
    model: { available: modelAvailable, offlineReason: agent.route.reason },
    projectedCostMicro: estimateMicro,
    budget: {
      limitMicro: agent.budget.limitMicro,
      spentMicro: agent.budget.spentMicro + (opts.extraSpentMicro ?? 0),
    },
    untrustedContent: opts.untrustedContent ?? false,
  });
  return { risk, policy, preview: redact(tool.preview(input)), estimateMicro };
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
    const url = (s.output as Out)?.finalUrl;
    if (s.tool_id !== 'web.fetch' || typeof url !== 'string') continue;
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
    if (s.tool_id === 'text.summarize' && typeof n === 'number') excluded = (excluded ?? 0) + n;
  }
  const signals = new Set<string>();
  for (const s of flagged) {
    const list = (s.output as Out)?.injectionSignals;
    if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') signals.add(id);
  }
  return { host, excludedSentences: excluded, signals: [...signals].sort() };
}
