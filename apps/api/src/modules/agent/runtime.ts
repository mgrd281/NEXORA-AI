import type { ToolId } from '@jarvis/contracts';
import type { Config } from '../../config';
import type { Db } from '../../db/pool';
import type { SecretBox } from '../../lib/crypto';
import type { ObjectStorage } from '../storage/types';
import type { ModelAdapter } from './models/adapter';
import { createAnthropicAdapter } from './models/anthropic';
import { apiKeyConfigured } from './models/router';

export interface RuntimeLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export const silentLogger: RuntimeLogger = { info() {}, warn() {}, error() {} };

/** Dependencies of the job handlers (planning, execution, expiry). */
export interface RuntimeDeps {
  config: Config;
  db: Db;
  secrets: SecretBox;
  /** Model adapter used in model mode; null when no API key is configured. */
  adapter: ModelAdapter | null;
  /** Phase B: attachment storage (null when STORAGE_DRIVER is 'none'). */
  storage: ObjectStorage | null;
  log: RuntimeLogger;
  /**
   * The clock of the scheduler and retention jobs (default: the system clock).
   * Tests move it to make occurrences due, e.g. across a DST change.
   */
  now?: () => Date;
  /**
   * Aborted when the worker lost this job's lease (it could not extend it in
   * time, so the job may already be running elsewhere). Tool and model calls
   * get it; handlers check it between steps (checkLease) and write nothing
   * more once it is aborted. The worker keeps the lease alive meanwhile.
   */
  signal?: AbortSignal;
  /**
   * Fault injection for crash-recovery tests: runs after a tool's side effect
   * completed and before its outcome is recorded. Throwing here simulates the
   * worker dying at the worst possible moment. Never set in production.
   */
  testHooks?: { afterToolExecute?: (toolId: ToolId) => void | Promise<void> };
}

export function createModelAdapter(config: Config): ModelAdapter | null {
  return apiKeyConfigured(config)
    ? createAnthropicAdapter({ apiKey: config.ANTHROPIC_API_KEY!.trim() })
    : null;
}

/** The worker lost the job's lease: stop without recording anything (see RuntimeDeps.signal). */
export class LeaseLostError extends Error {
  constructor(jobId?: number) {
    super(jobId === undefined ? 'job lease lost' : `lease of job ${jobId} lost`);
    this.name = 'LeaseLostError';
  }
}

export const nowOf = (deps: Pick<RuntimeDeps, 'now'>): Date => (deps.now ? deps.now() : new Date());

/** Checkpoint: throws LeaseLostError once the job's lease is lost. Call before every write. */
export function checkLease(deps: RuntimeDeps): void {
  if (deps.signal?.aborted) throw new LeaseLostError();
}

/** `signal` combined with the lease signal, if there is one. */
export function withLeaseSignal(deps: RuntimeDeps, signal: AbortSignal): AbortSignal {
  return deps.signal ? AbortSignal.any([signal, deps.signal]) : signal;
}
