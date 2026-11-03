/** Glue between a step, its tool and the policy engine (used at plan and execution time). */
import { RISK_ORDER, type RiskLevel } from '@jarvis/contracts';
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
