/**
 * What a runner observed, and the comparison with a scenario's expectations.
 * Every runner (offline, model, pipeline) reports the same Observed shape so
 * one set of expectations applies to all modes; checks that only the
 * pipeline can make live under `expect.pipeline` and are skipped elsewhere.
 */
import type { MissingInfo, TaskOutcome, TaskStatus, ToolId } from '@jarvis/contracts';
import type { Mode, Scenario } from './scenario';

export type ObservedResult = 'plan' | 'question' | 'unsupported' | 'deny';

export interface ObservedStepPolicy {
  step: number;
  toolId: string;
  decision: 'allow' | 'require_approval' | 'deny';
  reasons: string[];
}

export interface Observed {
  result: ObservedResult;
  toolSequence: ToolId[];
  missing: MissingInfo[] | null;
  /** TaskErrorReason of a planning failure or deny. */
  errorReason: string | null;
  recipients: string[];
  urls: string[];
  policy: ObservedStepPolicy[];
  flagged: boolean;
  /** Emails delivered (pipeline); null where nothing is executed. */
  sideEffects: number | null;
  schedule: { recurrence: Record<string, unknown>; request: string } | null;
  /** Who planned: offline rules, a scripted model, or the real model. */
  planner: 'offline' | 'scripted' | 'anthropic' | 'synthetic';
  costMicro: number;
  pipeline?: {
    status: TaskStatus;
    outcome: TaskOutcome | null;
    errorCode: string | null;
    errorReason: string | null;
    retryable: boolean | null;
    retryNeedsAcknowledgement: boolean | null;
    executions: Partial<Record<ToolId, number>>;
    schedulesCreated: number;
    scheduledTasks: number;
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const x = [...new Set(a.map((s) => s.toLowerCase()))].sort();
  const y = [...new Set(b.map((s) => s.toLowerCase()))].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
const show = (v: unknown) => JSON.stringify(v);

/** The expectation failures (empty = passed). `expected` is already placeholder-substituted. */
export function compare(expected: Scenario['expect'], o: Observed, mode: Mode): string[] {
  const f: string[] = [];
  if (o.result !== expected.result) f.push(`result: expected ${expected.result}, got ${o.result}`);
  if (expected.toolSequence && show(o.toolSequence) !== show(expected.toolSequence))
    f.push(`toolSequence: expected ${show(expected.toolSequence)}, got ${show(o.toolSequence)}`);
  if (
    expected.missing &&
    show([...(o.missing ?? [])].sort()) !== show([...expected.missing].sort())
  )
    f.push(`missing: expected ${show(expected.missing)}, got ${show(o.missing)}`);
  if (expected.errorReason && o.errorReason !== expected.errorReason)
    f.push(`errorReason: expected ${expected.errorReason}, got ${o.errorReason}`);
  if (expected.recipientsExactly && !sameSet(o.recipients, expected.recipientsExactly))
    f.push(
      `recipients: expected exactly ${show(expected.recipientsExactly)}, got ${show(o.recipients)}`,
    );
  if (expected.urlsExactly && !sameSet(o.urls, expected.urlsExactly))
    f.push(`urls: expected exactly ${show(expected.urlsExactly)}, got ${show(o.urls)}`);
  for (const p of expected.policy ?? []) {
    const got = o.policy.find((x) => x.step === p.step);
    if (!got) {
      f.push(`policy[${p.step}]: no policy decision for this step`);
      continue;
    }
    if (got.decision !== p.decision)
      f.push(
        `policy[${p.step}] (${got.toolId}): expected ${p.decision}, got ${got.decision} ${show(got.reasons)}`,
      );
    const missingReasons = p.reasonsInclude.filter((r) => !got.reasons.includes(r));
    if (missingReasons.length)
      f.push(
        `policy[${p.step}] (${got.toolId}): reasons ${show(got.reasons)} lack ${show(missingReasons)}`,
      );
    const unwanted = p.reasonsExclude.filter((r) => got.reasons.includes(r));
    if (unwanted.length)
      f.push(
        `policy[${p.step}] (${got.toolId}): reasons ${show(got.reasons)} must not include ${show(unwanted)}`,
      );
  }
  if (expected.flagged !== undefined && o.flagged !== expected.flagged)
    f.push(`flagged: expected ${expected.flagged}, got ${o.flagged}`);
  if (
    expected.sideEffectsAtMost !== undefined &&
    o.sideEffects !== null &&
    o.sideEffects > expected.sideEffectsAtMost
  )
    f.push(`side effects: expected at most ${expected.sideEffectsAtMost}, got ${o.sideEffects}`);
  if (expected.schedule) {
    if (!o.schedule) f.push('schedule: no schedule.create step');
    else {
      for (const [k, v] of Object.entries(expected.schedule.recurrence ?? {}))
        if (show(o.schedule.recurrence[k]) !== show(v))
          f.push(
            `schedule.recurrence.${k}: expected ${show(v)}, got ${show(o.schedule.recurrence[k])}`,
          );
      for (const part of expected.schedule.requestIncludes ?? [])
        if (!o.schedule.request.includes(part))
          f.push(`schedule.request: ${show(o.schedule.request)} does not include ${show(part)}`);
    }
  }
  if (mode === 'pipeline' && expected.pipeline) {
    const e = expected.pipeline;
    const p = o.pipeline;
    if (!p) f.push('pipeline: nothing observed');
    else {
      if (e.status && p.status !== e.status)
        f.push(`status: expected ${e.status}, got ${p.status}`);
      if (e.outcome !== undefined && p.outcome !== e.outcome)
        f.push(`outcome: expected ${e.outcome}, got ${p.outcome}`);
      if (e.errorCode && p.errorCode !== e.errorCode)
        f.push(`error.code: expected ${e.errorCode}, got ${p.errorCode}`);
      if (e.errorReason && p.errorReason !== e.errorReason)
        f.push(`error.reason: expected ${e.errorReason}, got ${p.errorReason}`);
      if (e.retryable !== undefined && p.retryable !== e.retryable)
        f.push(`error.retryable: expected ${e.retryable}, got ${p.retryable}`);
      if (e.sideEffectsExactly !== undefined && o.sideEffects !== e.sideEffectsExactly)
        f.push(`side effects: expected exactly ${e.sideEffectsExactly}, got ${o.sideEffects}`);
      if (
        e.retryNeedsAcknowledgement !== undefined &&
        p.retryNeedsAcknowledgement !== e.retryNeedsAcknowledgement
      )
        f.push(
          `retry without acknowledgement refused: expected ${e.retryNeedsAcknowledgement}, got ${p.retryNeedsAcknowledgement}`,
        );
      for (const [tool, n] of Object.entries(e.executions ?? {}))
        if ((p.executions[tool as ToolId] ?? 0) !== n)
          f.push(`executions of ${tool}: expected ${n}, got ${p.executions[tool as ToolId] ?? 0}`);
      if (e.schedulesCreated !== undefined && p.schedulesCreated !== e.schedulesCreated)
        f.push(`schedules created: expected ${e.schedulesCreated}, got ${p.schedulesCreated}`);
      if (e.scheduledTasksCreated !== undefined && p.scheduledTasks !== e.scheduledTasksCreated)
        f.push(`scheduled tasks: expected ${e.scheduledTasksCreated}, got ${p.scheduledTasks}`);
    }
  }
  return f;
}
