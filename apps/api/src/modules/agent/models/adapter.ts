import type { z } from 'zod';

/**
 * What a model call is for. The router maps each purpose to a tier
 * (see router.ts) and every call is metered under its purpose.
 */
export type ModelPurpose =
  | 'planning'
  | 'answer'
  | 'summarize'
  | 'result_summary'
  // Phase B
  | 'translate'
  | 'analyze_document'
  // Phase D: one decision of the model dialog on a phone call (latency-bound, small output)
  | 'call_dialog';
export type Effort = 'low' | 'medium' | 'high';

export interface ModelUsage {
  provider: string;
  /** The model that actually served the request (may differ after a server-side fallback). */
  model: string;
  purpose: ModelPurpose;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicro: number;
}

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface BaseRequest {
  purpose: ModelPurpose;
  model: string;
  effort: Effort;
  /** Must be byte-stable across calls (no timestamps/ids) so prompt caching works. */
  system: string;
  messages: ModelMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface ObjectRequest<T> extends BaseRequest {
  schema: z.ZodType<T>;
}

export interface TextRequest extends BaseRequest {
  /** Called for every streamed text delta (streaming is used only when provided). */
  onDelta?: (text: string) => void | Promise<void>;
}

/**
 * Structured output either parsed and schema-valid, or the raw text plus the
 * reasons it was rejected (so the caller can run a repair attempt).
 */
export type ObjectResult<T> =
  | { ok: true; value: T; usage: ModelUsage }
  | { ok: false; raw: string; issues: string[]; usage: ModelUsage };

export interface TextResult {
  text: string;
  /** True when generation stopped at max_tokens. */
  truncated: boolean;
  usage: ModelUsage;
}

/**
 * Provider-neutral model interface. Implementations must:
 *  - throw AgentError('MODEL_ERROR', …) for provider failures and refusals,
 *    with `retryable` set only for transient conditions (429, 5xx, network);
 *  - never return refused or truncated content as if it were a normal answer.
 */
export interface ModelAdapter {
  readonly provider: string;
  generateObject<T>(req: ObjectRequest<T>): Promise<ObjectResult<T>>;
  generateText(req: TextRequest): Promise<TextResult>;
}
