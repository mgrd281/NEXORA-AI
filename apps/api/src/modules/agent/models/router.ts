/**
 * Model routing. Two decisions, both deterministic:
 *
 * 1. Mode (per user, re-evaluated before every model call):
 *      no ANTHROPIC_API_KEY                         → offline (NO_API_KEY)
 *      preferences.ai.allowExternalModels = false   → offline (USER_DISABLED_EXTERNAL_MODELS)
 *      AI spend this calendar month (UTC) ≥ budget  → offline (BUDGET_EXHAUSTED)
 *      otherwise                                    → model (provider 'anthropic')
 *    Offline means: the deterministic rules planner plans, text.summarize is
 *    extractive, and assistant.answer is unavailable. Nothing leaves the server.
 *
 * 2. Tier per purpose (only in model mode):
 *      planning        → MODEL_DEEP     (Claude Opus 5.5, effort medium) — the plan
 *                                          is the safety-critical artefact, so it
 *                                          gets the strongest model.
 *      answer          → MODEL_BALANCED (Claude Sonnet 5.5, effort medium)
 *      summarize       → MODEL_FAST     (Claude Haiku 5.5, effort low); text longer
 *                                          than 60k chars → MODEL_BALANCED
 *      result_summary  → MODEL_FAST     (effort low) — one or two sentences.
 *    Thinking is never configured explicitly (adaptive by default on these
 *    models); depth is controlled with output_config.effort only.
 */
import type { Config } from '../../../config';
import type { Effort, ModelPurpose } from './adapter';

export type OfflineReason = 'NO_API_KEY' | 'USER_DISABLED_EXTERNAL_MODELS' | 'BUDGET_EXHAUSTED';

export interface ModelRoute {
  mode: 'model' | 'offline';
  provider: 'anthropic' | null;
  reason: OfflineReason | null;
}

export interface RouteInput {
  apiKeyConfigured: boolean;
  allowExternalModels: boolean;
  budgetMicro: number;
  spentMicro: number;
}

export function decideRoute(i: RouteInput): ModelRoute {
  if (!i.apiKeyConfigured) return { mode: 'offline', provider: null, reason: 'NO_API_KEY' };
  if (!i.allowExternalModels)
    return { mode: 'offline', provider: null, reason: 'USER_DISABLED_EXTERNAL_MODELS' };
  if (i.budgetMicro <= 0 || i.spentMicro >= i.budgetMicro)
    return { mode: 'offline', provider: null, reason: 'BUDGET_EXHAUSTED' };
  return { mode: 'model', provider: 'anthropic', reason: null };
}

export function apiKeyConfigured(config: Pick<Config, 'ANTHROPIC_API_KEY'>): boolean {
  return !!config.ANTHROPIC_API_KEY && config.ANTHROPIC_API_KEY.trim().length > 0;
}

/** Text above this size goes to the balanced tier for summarisation. */
export const LONG_TEXT_CHARS = 60_000;

export interface ModelChoice {
  model: string;
  effort: Effort;
  maxTokens: number;
}

export function selectModel(
  config: Pick<Config, 'MODEL_FAST' | 'MODEL_BALANCED' | 'MODEL_DEEP'>,
  purpose: ModelPurpose,
  opts: { inputChars?: number } = {},
): ModelChoice {
  switch (purpose) {
    case 'planning':
      return { model: config.MODEL_DEEP, effort: 'medium', maxTokens: 16_000 };
    case 'answer':
      return { model: config.MODEL_BALANCED, effort: 'medium', maxTokens: 16_000 };
    case 'summarize':
      return (opts.inputChars ?? 0) > LONG_TEXT_CHARS
        ? { model: config.MODEL_BALANCED, effort: 'low', maxTokens: 8_000 }
        : { model: config.MODEL_FAST, effort: 'low', maxTokens: 8_000 };
    case 'result_summary':
      return { model: config.MODEL_FAST, effort: 'low', maxTokens: 2_000 };
  }
}
