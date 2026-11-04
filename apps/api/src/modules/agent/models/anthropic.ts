/**
 * Anthropic implementation of ModelAdapter (@anthropic-ai/sdk 1.4.0).
 *
 * - Structured output: output_config.format from betaZodOutputFormat(schema).
 *   We call messages.create and parse the text ourselves *after* checking
 *   stop_reason: messages.parse() validates eagerly and would throw on a
 *   refused or truncated response before stop_reason could be inspected.
 * - Text: messages.stream when deltas are wanted, otherwise create.
 * - Thinking is never configured (adaptive by default; Opus 5.5 rejects
 *   disabling it); depth is set with output_config.effort. No sampling params.
 * - Forced tool_choice is never used (400 on Opus/Sonnet 5.5).
 * - stop_reason 'refusal' → MODEL_ERROR "The model declined this request"
 *   (non-retryable); 'max_tokens' → truncated.
 * - Server-side refusal fallbacks (beta server-side-fallback-2026-07-01,
 *   fallbacks: 'default') are enabled for Opus/Sonnet/Fable models; the model
 *   that actually served the response is what we bill.
 * - Prompt caching: system prompts are byte-stable; top-level cache_control.
 * - Client: 120 s timeout, 2 SDK retries (408/409/429/5xx/connection).
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { metrics } from '../../../observability/metrics';
import { addSpanAttributes, withSpan } from '../../../observability/tracing';
import { AgentError } from '../errors';
import type {
  ModelAdapter,
  ModelPurpose,
  ModelUsage,
  ObjectRequest,
  ObjectResult,
  TextRequest,
  TextResult,
} from './adapter';
import { costMicro } from './pricing';

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const REFUSAL_MESSAGE = 'The model declined this request.';

/** Server-side fallbacks are offered for the Opus, Sonnet and Fable families. */
export function supportsServerFallback(model: string): boolean {
  return /^claude-(opus|sonnet|fable)-/.test(model);
}

/** The subset of the SDK client this adapter uses (lets tests inject a fake). */
export interface AnthropicClientLike {
  beta: {
    messages: {
      create: Anthropic['beta']['messages']['create'];
      stream: Anthropic['beta']['messages']['stream'];
    };
  };
}

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaUsage = Anthropic.Beta.Messages.BetaUsage;

/** Usage of one response, billed per model actually used (fallback iterations included). */
export function usageFrom(
  purpose: ModelPurpose,
  requestedModel: string,
  message: Pick<BetaMessage, 'model' | 'usage'>,
): ModelUsage {
  const u: BetaUsage = message.usage;
  const served = message.model || requestedModel;
  let cost = 0;
  const iterations = u.iterations ?? [];
  if (iterations.length > 0) {
    for (const it of iterations) {
      const model = ('model' in it && it.model) || served;
      cost += costMicro(model, {
        input: it.input_tokens ?? 0,
        output: it.output_tokens ?? 0,
        cacheRead: it.cache_read_input_tokens ?? 0,
        cacheWrite: it.cache_creation_input_tokens ?? 0,
      });
    }
  } else {
    cost = costMicro(served, {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    });
  }
  return {
    provider: 'anthropic',
    model: served,
    purpose,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    costMicro: cost,
  };
}

/** Maps SDK errors to user-safe AgentErrors (most specific first). */
export function mapAnthropicError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  const transient = (message: string) =>
    new AgentError('MODEL_ERROR', message, { retryable: true, transient: true });
  const permanent = (message: string) =>
    new AgentError('MODEL_ERROR', message, { retryable: false });
  if (err instanceof Anthropic.APIUserAbortError)
    return transient('The AI model request was cancelled or timed out.');
  if (err instanceof Anthropic.APIConnectionError)
    return transient('Could not reach the AI model provider.');
  if (err instanceof Anthropic.RateLimitError)
    return transient('The AI model provider is busy right now. Try again shortly.');
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  )
    return permanent('The AI model provider rejected the configured API key.');
  if (err instanceof Anthropic.BadRequestError) {
    // The provider's reason (e.g. an invalid parameter or a schema it cannot compile) is
    // technical, not secret: keep a bounded copy so the task's technical details say why.
    const reason = String(err.message ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 300);
    return permanent(`The AI model provider rejected the request.${reason ? ` (${reason})` : ''}`);
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (status === 408 || status === 409 || status === 429 || status >= 500)
      return transient('The AI model provider had a temporary problem.');
    return permanent('The AI model request failed.');
  }
  return permanent('The AI model request failed.');
}

type Block = BetaMessage['content'][number];
const joinText = (blocks: Block[]) =>
  blocks
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

/** All text of a response. After a server-side fallback the serving model continues the turn. */
function textOf(message: Pick<BetaMessage, 'content'>): string {
  return joinText(message.content);
}

/** Text produced after the last fallback boundary (if any), for re-parsing structured output. */
function textAfterFallback(message: Pick<BetaMessage, 'content'>): string | null {
  const idx = message.content.map((b) => b.type).lastIndexOf('fallback');
  return idx < 0 ? null : joinText(message.content.slice(idx + 1));
}

/**
 * Telemetry of one call (counts and ids only, never prompts or output): the
 * served model, token counts and stop reason on the model.call span, and the
 * model usage metric — for refused calls too (they are billed).
 */
function observe(usage: ModelUsage, stopReason: string | null): void {
  addSpanAttributes({
    'gen_ai.response.model': usage.model,
    'gen_ai.usage.input_tokens': usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    'gen_ai.usage.output_tokens': usage.outputTokens,
    'gen_ai.response.finish_reason': stopReason ?? 'unknown',
  });
  metrics.modelUsage({
    model: usage.model,
    purpose: usage.purpose,
    inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    costMicro: usage.costMicro,
  });
}

const spanAttributes = (req: { model: string; purpose: ModelPurpose; effort: string }) => ({
  'gen_ai.system': 'anthropic',
  'gen_ai.request.model': req.model,
  'jarvis.model.purpose': req.purpose,
  'jarvis.model.effort': req.effort,
});

export function createAnthropicAdapter(opts: {
  apiKey?: string;
  client?: AnthropicClientLike;
}): ModelAdapter {
  const client: AnthropicClientLike =
    opts.client ?? new Anthropic({ apiKey: opts.apiKey, timeout: 120_000, maxRetries: 2 });

  function base(req: ObjectRequest<unknown> | TextRequest) {
    const fallback = supportsServerFallback(req.model);
    return {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
      cache_control: { type: 'ephemeral' as const },
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    };
  }

  function refused(purpose: ModelPurpose, model: string, message: BetaMessage): AgentError {
    return new AgentError('MODEL_ERROR', REFUSAL_MESSAGE, {
      retryable: false,
      usage: [usageFrom(purpose, model, message)],
    });
  }

  async function objectCall<T>(req: ObjectRequest<T>): Promise<ObjectResult<T>> {
    const format = betaZodOutputFormat(req.schema);
    let message: BetaMessage;
    try {
      message = (await client.beta.messages.create(
        {
          ...base(req),
          output_config: { format, effort: req.effort },
          stream: false,
        },
        { signal: req.signal },
      )) as BetaMessage;
    } catch (err) {
      throw mapAnthropicError(err);
    }
    const usage = usageFrom(req.purpose, req.model, message);
    observe(usage, message.stop_reason);
    if (message.stop_reason === 'refusal') throw refused(req.purpose, req.model, message);
    const raw = textOf(message);
    if (message.stop_reason === 'max_tokens') {
      return { ok: false, raw, issues: ['The response was cut off at the length limit.'], usage };
    }
    const candidates = [raw, textAfterFallback(message)].filter(
      (c): c is string => typeof c === 'string' && c.length > 0,
    );
    let detail = 'The response contained no structured output.';
    for (const candidate of candidates) {
      try {
        return { ok: true, value: format.parse(candidate) as T, usage };
      } catch (err) {
        detail = err instanceof Error ? err.message : String(err);
      }
    }
    return { ok: false, raw, issues: [detail.slice(0, 2_000)], usage };
  }

  async function textCall(req: TextRequest): Promise<TextResult> {
    let message: BetaMessage;
    try {
      if (req.onDelta) {
        const stream = client.beta.messages.stream(
          { ...base(req), output_config: { effort: req.effort } },
          { signal: req.signal },
        );
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            await req.onDelta(event.delta.text);
          }
        }
        message = (await stream.finalMessage()) as BetaMessage;
      } else {
        message = (await client.beta.messages.create(
          { ...base(req), output_config: { effort: req.effort }, stream: false },
          { signal: req.signal },
        )) as BetaMessage;
      }
    } catch (err) {
      throw mapAnthropicError(err);
    }
    observe(usageFrom(req.purpose, req.model, message), message.stop_reason);
    if (message.stop_reason === 'refusal') throw refused(req.purpose, req.model, message);
    return {
      text: textOf(message),
      truncated: message.stop_reason === 'max_tokens',
      usage: usageFrom(req.purpose, req.model, message),
    };
  }

  return {
    provider: 'anthropic',
    generateObject: <T>(req: ObjectRequest<T>) =>
      withSpan('model.call', spanAttributes(req), () => objectCall(req)),
    generateText: (req: TextRequest) =>
      withSpan('model.call', spanAttributes(req), () => textCall(req)),
  };
}
