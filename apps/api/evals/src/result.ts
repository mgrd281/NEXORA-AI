/** The outcome of one scenario in one mode. */
import type { Observed } from './expect';
import type { LoadedScenario, Mode, Suite } from './scenario';

export type RunStatus = 'passed' | 'failed' | 'pending';

export interface RunResult {
  id: string;
  version: number;
  suite: Suite;
  mode: Mode;
  title: string;
  file: string;
  status: RunStatus;
  /** Expectation failures, or the error that stopped the run. */
  failures: string[];
  /** Why a scenario is pending (missing capability, no API key, spend cap). */
  reason?: string;
  observed?: Observed;
  latencyMs: number;
  costMicro: number;
}

export function resultOf(
  s: LoadedScenario,
  mode: Mode,
  r: Pick<RunResult, 'status' | 'failures' | 'reason' | 'observed' | 'latencyMs' | 'costMicro'>,
): RunResult {
  return {
    id: s.id,
    version: s.version,
    suite: s.suite,
    mode,
    title: s.title,
    file: s.file,
    ...r,
  };
}

export function pending(s: LoadedScenario, mode: Mode, reason: string): RunResult {
  return resultOf(s, mode, { status: 'pending', failures: [], reason, latencyMs: 0, costMicro: 0 });
}

/** A run that threw: a failure with the error (never content: these are our own errors). */
export function errored(s: LoadedScenario, mode: Mode, err: unknown, latencyMs: number): RunResult {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return resultOf(s, mode, {
    status: 'failed',
    failures: [`error: ${message.split('\n')[0]}`],
    latencyMs,
    costMicro: 0,
  });
}
