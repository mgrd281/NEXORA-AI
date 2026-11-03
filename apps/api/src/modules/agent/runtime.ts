import type { ToolId } from '@jarvis/contracts';
import type { Config } from '../../config';
import type { Db } from '../../db/pool';
import type { SecretBox } from '../../lib/crypto';
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
  log: RuntimeLogger;
  /** Extends the current job's lease; called periodically during long work. */
  keepAlive?: () => Promise<void>;
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

export const KEEPALIVE_INTERVAL_MS = 20_000;

/** Runs `fn` while periodically extending the job lease. */
export async function withKeepAlive<T>(deps: RuntimeDeps, fn: () => Promise<T>): Promise<T> {
  if (!deps.keepAlive) return fn();
  const keepAlive = deps.keepAlive;
  const timer = setInterval(() => {
    keepAlive().catch((err: unknown) =>
      deps.log.warn('lease extension failed', { error: String(err) }),
    );
  }, KEEPALIVE_INTERVAL_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}
