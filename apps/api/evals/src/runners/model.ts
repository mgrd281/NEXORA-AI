/**
 * Model runner: the model planner (planTask in model mode: structured output,
 * validatePlan, one repair attempt) followed by the same policy pass as the
 * offline runner.
 *
 * With ANTHROPIC_API_KEY set it calls the real Anthropic adapter, metering
 * every call and stopping at the spend cap (remaining scenarios are pending
 * "spend cap reached"). Without a key it plays the scenario's scripted plans
 * through the scripted adapter (test/fixtures/scripted-model.ts), which tests
 * everything around the model deterministically — validation, repair,
 * literalness, refusal handling, policy. Scenarios marked `scriptOnly`
 * (adversarial model output) always use their script; scenarios without a
 * script need a key and are pending otherwise.
 */
import { missingCapabilities } from '../capabilities';
import { compare } from '../expect';
import { errored, pending, resultOf, type RunResult } from '../result';
import type { LoadedScenario } from '../scenario';
import { ScriptedModel } from '../../../test/fixtures/scripted-model';
import { AgentError } from '../../../src/modules/agent/errors';
import type { ModelAdapter } from '../../../src/modules/agent/models/adapter';
import { createAnthropicAdapter } from '../../../src/modules/agent/models/anthropic';
import { planTask } from '../../../src/modules/agent/planner';
import {
  agentContext,
  evalConfig,
  observeFailure,
  observePlan,
  OFFLINE_DOWN,
  OFFLINE_SITE,
  planningInput,
  prepare,
} from './common';

const MODEL_ROUTE = { mode: 'model', provider: 'anthropic', reason: null } as const;

export interface ModelBudget {
  /** Stop calling the real model once this much was spent (micro-USD). */
  capMicro: number;
  spentMicro: number;
}

function scripted(plans: unknown[], refuse: boolean): ModelAdapter {
  let call = 0;
  return new ScriptedModel({
    object: () => {
      if (refuse)
        throw new AgentError('MODEL_ERROR', 'The model declined this request.', {
          retryable: false,
        });
      return plans[Math.min(call++, plans.length - 1)];
    },
  });
}

export async function runModel(
  s: LoadedScenario,
  opts: { apiKey?: string; budget: ModelBudget },
): Promise<RunResult> {
  const missing = await missingCapabilities(s.requires, { mode: 'model' });
  if (missing.length) return pending(s, 'model', `capability missing: ${missing.join(', ')}`);
  const script = s.given.model;
  const useScript = !!script && (script.scriptOnly || !opts.apiKey);
  if (!useScript && !opts.apiKey)
    return pending(s, 'model', 'needs ANTHROPIC_API_KEY (no scripted plans)');
  if (!useScript && opts.budget.spentMicro >= opts.budget.capMicro)
    return pending(s, 'model', 'spend cap reached');

  const started = performance.now();
  try {
    const config = evalConfig(opts.apiKey && !useScript ? { ANTHROPIC_API_KEY: opts.apiKey } : {});
    const p = await prepare(s, { site: OFFLINE_SITE, down: OFFLINE_DOWN });
    const adapter = useScript
      ? scripted(p.modelPlans ?? [], script!.refuse)
      : createAnthropicAdapter({ apiKey: opts.apiKey });
    const planner = useScript ? 'scripted' : 'anthropic';
    const agent = agentContext(p, MODEL_ROUTE);
    const outcome = await planTask(
      { config, adapter, route: MODEL_ROUTE },
      planningInput(p, agent),
    );
    // Scripted calls cost nothing: their usage figures are made up, so they are not reported as spend.
    const cost = useScript ? 0 : outcome.usage.reduce((n, u) => n + u.costMicro, 0);
    opts.budget.spentMicro += cost;
    const observed = outcome.ok
      ? observePlan(outcome.plan, p, agent, config, planner, cost)
      : observeFailure(outcome.error.reason ?? null, planner, cost);
    // Planner rule 10: what JARVIS cannot do is answered honestly (assistant.answer only).
    if (
      p.expect.result === 'unsupported' &&
      observed.result === 'plan' &&
      observed.toolSequence.length > 0 &&
      observed.toolSequence.every((t) => t === 'assistant.answer')
    )
      observed.result = 'unsupported';
    const failures = compare(p.expect, observed, 'model');
    return resultOf(s, 'model', {
      status: failures.length ? 'failed' : 'passed',
      failures,
      observed,
      latencyMs: performance.now() - started,
      costMicro: cost,
    });
  } catch (err) {
    return errored(s, 'model', err, performance.now() - started);
  }
}
