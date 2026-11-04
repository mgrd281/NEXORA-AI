/**
 * Offline runner: the deterministic rules planner (planTask in offline mode
 * = planOffline → validatePlan), then the policy engine through assessStep
 * exactly as plan-job.ts and executor.ts call it. No database, no network,
 * no model: the same input gives the same report on every machine.
 */
import { missingCapabilities } from '../capabilities';
import { compare } from '../expect';
import { errored, pending, resultOf, type RunResult } from '../result';
import type { LoadedScenario } from '../scenario';
import { planTask } from '../../../src/modules/agent/planner';
import { detectInjection } from '../../../src/modules/agent/tools/injection';
import { loadInjectionCorpus } from '../fixtures';
import {
  agentContext,
  evalConfig,
  observeFailure,
  observePlan,
  observeSynthetic,
  OFFLINE_DOWN,
  OFFLINE_SITE,
  planningInput,
  prepare,
} from './common';

const OFFLINE_ROUTE = { mode: 'offline', provider: null, reason: 'NO_API_KEY' } as const;

export async function runOffline(s: LoadedScenario): Promise<RunResult> {
  const missing = await missingCapabilities(s.requires, { mode: 'offline' });
  if (missing.length) return pending(s, 'offline', `capability missing: ${missing.join(', ')}`);
  const started = performance.now();
  try {
    const config = evalConfig();
    const p = await prepare(s, { site: OFFLINE_SITE, down: OFFLINE_DOWN });
    const agent = agentContext(p, OFFLINE_ROUTE);
    let observed;
    if (s.given.corpus !== undefined) return await runCorpus(s, started);
    if (s.given.syntheticSteps) {
      observed = observeSynthetic(p, agent);
    } else {
      const outcome = await planTask(
        { config, adapter: null, route: OFFLINE_ROUTE },
        planningInput(p, agent),
      );
      observed = outcome.ok
        ? observePlan(outcome.plan, p, agent, config, 'offline', 0)
        : observeFailure(outcome.error.reason ?? null, 'offline', 0);
    }
    const failures = compare(p.expect, observed, 'offline');
    return resultOf(s, 'offline', {
      status: failures.length ? 'failed' : 'passed',
      failures,
      observed,
      latencyMs: performance.now() - started,
      costMicro: 0,
    });
  } catch (err) {
    return errored(s, 'offline', err, performance.now() - started);
  }
}

/** Every line of an injection corpus through the runtime's detector. */
async function runCorpus(s: LoadedScenario, started: number): Promise<RunResult> {
  const want = s.expect.flagged!;
  const lines = await loadInjectionCorpus(s.given.corpus!);
  const wrong = lines.filter((l) => detectInjection(l).suspectedInjection !== want);
  const failures = [
    ...(lines.length === 0 ? ['corpus is empty'] : []),
    ...wrong.map((l) => `${want ? 'not flagged' : 'flagged'}: ${l}`),
  ];
  return resultOf(s, 'offline', {
    status: failures.length ? 'failed' : 'passed',
    failures,
    latencyMs: performance.now() - started,
    costMicro: 0,
  });
}
