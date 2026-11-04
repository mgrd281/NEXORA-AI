/**
 * Runtime telemetry call sites: the Anthropic adapter's model.call span and
 * model metrics carry ids, enums and counts only — never the prompt or the
 * output — and with telemetry off the calls are plain no-ops.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/config';
import {
  createAnthropicAdapter,
  type AnthropicClientLike,
} from '../../../src/modules/agent/models/anthropic';
import { renderMetrics, startMetrics, stopMetrics } from '../../../src/observability/metrics';
import { startTracing, stopTracing } from '../../../src/observability/tracing';

const SECRET_PROMPT = 'My passport number is X1234567 and my address is 5 Main St';
const SECRET_OUTPUT = 'Summary of the passport X1234567';

function client(): AnthropicClientLike {
  return {
    beta: {
      messages: {
        create: vi.fn(async () => ({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [{ type: 'text', text: SECRET_OUTPUT, citations: null }],
          stop_reason: 'end_turn',
          stop_details: null,
          stop_sequence: null,
          usage: {
            input_tokens: 1_200,
            output_tokens: 80,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        })),
        stream: vi.fn(),
      },
    },
  } as unknown as AnthropicClientLike;
}

interface Ended {
  name: string;
  attributes: Record<string, unknown>;
}

afterEach(async () => {
  await stopTracing();
  await stopMetrics();
});

describe('model.call telemetry', () => {
  it('is a no-op with telemetry off', async () => {
    const adapter = createAnthropicAdapter({ client: client() });
    const res = await adapter.generateText({
      purpose: 'summarize',
      model: 'claude-haiku-5-5',
      effort: 'low',
      maxTokens: 100,
      system: 'S',
      messages: [{ role: 'user', content: SECRET_PROMPT }],
    });
    expect(res.text).toBe(SECRET_OUTPUT);
  });

  it('records the model, purpose, token counts and stop reason — no content', async () => {
    const ended: Ended[] = [];
    await startTracing(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
        OTEL_SERVICE_NAME: 'test',
        APP_VERSION: '0',
        NODE_ENV: 'test',
      } as Pick<
        Config,
        'OTEL_EXPORTER_OTLP_ENDPOINT' | 'OTEL_SERVICE_NAME' | 'APP_VERSION' | 'NODE_ENV'
      >,
      'worker',
      {
        spanProcessors: [
          {
            onStart() {},
            onEnd(span) {
              const s = span as { name: string; attributes: Record<string, unknown> };
              ended.push({ name: s.name, attributes: { ...s.attributes } });
            },
            forceFlush: async () => {},
            shutdown: async () => {},
          },
        ],
      },
    );
    await startMetrics('worker', '0');
    const adapter = createAnthropicAdapter({ client: client() });
    await adapter.generateText({
      purpose: 'summarize',
      model: 'claude-haiku-5-5',
      effort: 'low',
      maxTokens: 100,
      system: 'S',
      messages: [{ role: 'user', content: SECRET_PROMPT }],
    });
    const span = ended.find((s) => s.name === 'model.call');
    expect(span?.attributes).toMatchObject({
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': 'claude-haiku-5-5',
      'gen_ai.response.model': 'claude-haiku-5-5',
      'gen_ai.usage.input_tokens': 1_200,
      'gen_ai.usage.output_tokens': 80,
      'gen_ai.response.finish_reason': 'end_turn',
      'jarvis.model.purpose': 'summarize',
    });
    const all = JSON.stringify(ended);
    expect(all).not.toContain('X1234567');
    expect(all).not.toContain('Main St');

    const scraped = (await renderMetrics(null)).body;
    expect(scraped).toMatch(
      /jarvis_model_calls_total\{[^}]*model="claude-haiku-5-5"[^}]*purpose="summarize"[^}]*\} 1/,
    );
    expect(scraped).toMatch(/jarvis_model_tokens_total\{[^}]*direction="input"[^}]*\} 1200/);
    expect(scraped).not.toContain('X1234567');
  });
});
