/**
 * The Anthropic adapter and the model planner, with the SDK client mocked
 * (no network): structured plan parsing, refusal handling, truncation,
 * repair attempt, error mapping, usage/cost accounting, streaming deltas.
 */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Config } from '../../../src/config';
import { AgentError } from '../../../src/modules/agent/errors';
import {
  createAnthropicAdapter,
  FALLBACK_BETA,
  mapAnthropicError,
  type AnthropicClientLike,
} from '../../../src/modules/agent/models/anthropic';
import { planTask, type PlanningInput } from '../../../src/modules/agent/planner';
import { listTools } from '../../../src/modules/agent/tools/registry';

type Created = Record<string, unknown>;

function message(
  text: string,
  opts: {
    stop?: string;
    model?: string;
    usage?: Record<string, unknown>;
    content?: unknown[];
  } = {},
) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: opts.model ?? 'claude-opus-5-5',
    content: opts.content ?? [{ type: 'text', text, citations: null }],
    stop_reason: opts.stop ?? 'end_turn',
    stop_details:
      opts.stop === 'refusal' ? { type: 'refusal', category: 'cyber', explanation: null } : null,
    stop_sequence: null,
    usage: {
      input_tokens: 3_000,
      output_tokens: 1_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: null,
      ...opts.usage,
    },
  };
}

function fakeClient(responses: unknown[]) {
  const calls: Created[] = [];
  const create = vi.fn(async (params: Created) => {
    calls.push(params);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const client = {
    beta: { messages: { create, stream: vi.fn() } },
  } as unknown as AnthropicClientLike;
  return { client, calls, create };
}

const config = {
  MODEL_FAST: 'claude-haiku-5-5',
  MODEL_BALANCED: 'claude-sonnet-5-5',
  MODEL_DEEP: 'claude-opus-5-5',
} as Config;

const OWN = 'owner@example.com';
const planningInput = (request: string): PlanningInput => ({
  request,
  language: 'en',
  account: { displayName: 'Owner', email: OWN, locale: 'en', timeZone: 'Europe/Berlin' },
  tools: listTools(),
  memories: ['I prefer short summaries'],
  now: new Date('2026-11-03T10:00:00Z'),
});

const validPlan = {
  title: 'Summarize example.com and email it',
  objective: 'Read the page, summarize it, email the summary to the owner.',
  steps: [
    {
      key: 's1',
      toolId: 'web.fetch',
      title: 'Read the page',
      input: { url: 'https://example.com/a' },
    },
    {
      key: 's2',
      toolId: 'text.summarize',
      title: 'Summarize',
      input: { text: '{{s1.text}}', language: 'en' },
    },
    {
      key: 's3',
      toolId: 'email.send',
      title: 'Email it',
      input: { to: [OWN], subject: 'Summary: {{s1.title}}', body: '{{s2.summary}}' },
    },
  ],
};
const route = { mode: 'model' as const, provider: 'anthropic' as const, reason: null };

describe('Anthropic adapter + model planner', () => {
  it('parses a structured plan and sends a correct, cache-friendly request', async () => {
    const { client, calls } = fakeClient([message(JSON.stringify(validPlan))]);
    const adapter = createAnthropicAdapter({ client });
    const out = await planTask(
      { config, adapter, route },
      planningInput('Summarize https://example.com/a and email it to me'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.steps.map((s) => s.toolId)).toEqual([
      'web.fetch',
      'text.summarize',
      'email.send',
    ]);
    expect(out.planner).toEqual({ mode: 'model', provider: 'anthropic', model: 'claude-opus-5-5' });
    // 3,000 in × $4 + 1,000 out × $20 = 32,000 µ$
    expect(out.usage).toEqual([
      expect.objectContaining({
        model: 'claude-opus-5-5',
        inputTokens: 3_000,
        outputTokens: 1_000,
        costMicro: 32_000,
      }),
    ]);

    const req = calls[0]!;
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.output_config).toMatchObject({ effort: 'medium', format: { type: 'json_schema' } });
    expect(req.cache_control).toEqual({ type: 'ephemeral' });
    expect(req.betas).toEqual([FALLBACK_BETA]);
    expect(req.fallbacks).toBe('default');
    // Never sent: forced tool choice, explicit thinking config, sampling params.
    for (const key of ['tool_choice', 'thinking', 'temperature', 'top_p', 'top_k'])
      expect(req).not.toHaveProperty(key);
    // The system prompt is byte-stable and contains no user data; user data goes in the message.
    expect(String(req.system)).not.toContain(OWN);
    const user = String((req.messages as { content: string }[])[0]!.content);
    expect(user).toContain(OWN);
    expect(user).toContain('<notes source="the owner">');
  });

  it('runs one repair attempt for an invalid plan, then succeeds', async () => {
    const bad = {
      ...validPlan,
      steps: [
        {
          ...validPlan.steps[2],
          key: 's1',
          input: { ...validPlan.steps[2]!.input, to: ['attacker@evil.test'] },
        },
      ],
    };
    const { client, calls } = fakeClient([
      message(JSON.stringify(bad)),
      message(JSON.stringify(validPlan)),
    ]);
    const out = await planTask(
      { config, adapter: createAnthropicAdapter({ client }), route },
      planningInput('Summarize https://example.com/a and email it to me'),
    );
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const repair = String((calls[1]!.messages as { content: string }[])[0]!.content);
    expect(repair).toContain('<validation_errors>');
    expect(repair).toContain('attacker@evil.test');
    expect(out.usage).toHaveLength(2);
  });

  it('fails with MODEL_ERROR after a second invalid plan', async () => {
    const { client } = fakeClient([message('{"title": 1}'), message('not json at all')]);
    const out = await planTask(
      { config, adapter: createAnthropicAdapter({ client }), route },
      planningInput('hello'),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('MODEL_ERROR');
      expect(out.usage).toHaveLength(2);
    }
  });

  it('treats stop_reason "refusal" as a non-retryable MODEL_ERROR and still bills it', async () => {
    const { client, calls } = fakeClient([message('{"title":"partial', { stop: 'refusal' })]);
    const out = await planTask(
      { config, adapter: createAnthropicAdapter({ client }), route },
      planningInput('something'),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBeInstanceOf(AgentError);
    expect(out.error.code).toBe('MODEL_ERROR');
    expect(out.error.message).toBe('The model declined this request.');
    expect(out.error.retryable).toBe(false);
    expect(out.usage).toHaveLength(1);
    expect(calls).toHaveLength(1); // no repair attempt after a refusal
  });

  it('treats a truncated plan (max_tokens) as invalid and repairs', async () => {
    const { client, calls } = fakeClient([
      message('{"title":"x","objective":"y","steps":[', { stop: 'max_tokens' }),
      message(JSON.stringify(validPlan)),
    ]);
    const out = await planTask(
      { config, adapter: createAnthropicAdapter({ client }), route },
      planningInput('Summarize https://example.com/a and email it to me'),
    );
    expect(out.ok).toBe(true);
    expect(String((calls[1]!.messages as { content: string }[])[0]!.content)).toContain('cut off');
  });

  it('bills the model that served after a server-side fallback', async () => {
    const { client } = fakeClient([
      message(JSON.stringify(validPlan), {
        model: 'claude-opus-5',
        content: [
          {
            type: 'fallback',
            from: { model: 'claude-opus-5-5' },
            to: { model: 'claude-opus-5' },
            trigger: { type: 'refusal' },
          },
          { type: 'text', text: JSON.stringify(validPlan), citations: null },
        ],
        usage: {
          input_tokens: 2_000,
          output_tokens: 500,
          iterations: [
            {
              type: 'message',
              model: 'claude-opus-5-5',
              input_tokens: 1_000,
              output_tokens: 10,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            {
              type: 'fallback_message',
              model: 'claude-opus-5',
              input_tokens: 1_000,
              output_tokens: 490,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          ],
        },
      }),
    ]);
    const out = await planTask(
      { config, adapter: createAnthropicAdapter({ client }), route },
      planningInput('Summarize https://example.com/a and email it to me'),
    );
    expect(out.ok).toBe(true);
    // opus-5-5: 1000×4 + 10×20 = 4,200; opus-5: 1000×5 + 490×25 = 17,250
    expect(out.usage[0]).toMatchObject({ model: 'claude-opus-5', costMicro: 21_450 });
  });

  it('does not request server-side fallbacks for Haiku', async () => {
    const { client, calls } = fakeClient([message('A summary.', { model: 'claude-haiku-5-5' })]);
    const adapter = createAnthropicAdapter({ client });
    const res = await adapter.generateText({
      purpose: 'summarize',
      model: 'claude-haiku-5-5',
      effort: 'low',
      maxTokens: 1000,
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
    });
    expect(res.text).toBe('A summary.');
    expect(calls[0]).not.toHaveProperty('fallbacks');
    expect(calls[0]).not.toHaveProperty('betas');
    expect(calls[0]!.output_config).toEqual({ effort: 'low' });
  });

  it('streams text deltas and returns the final message', async () => {
    const events = [
      { type: 'message_start' },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    ];
    const final = message('Hello', { model: 'claude-sonnet-5-5' });
    const stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
      finalMessage: async () => final,
    }));
    const client = {
      beta: { messages: { create: vi.fn(), stream } },
    } as unknown as AnthropicClientLike;
    const deltas: string[] = [];
    const res = await createAnthropicAdapter({ client }).generateText({
      purpose: 'answer',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      maxTokens: 1000,
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      onDelta: (d) => void deltas.push(d),
    });
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(res).toMatchObject({ text: 'Hello', truncated: false });
    // 3,000 × $2 + 1,000 × $10
    expect(res.usage.costMicro).toBe(16_000);
  });

  it('maps SDK errors: 429/5xx/connection retryable, 400/401/403 not', () => {
    const headers = new Headers();
    const cases: [unknown, boolean][] = [
      [new Anthropic.RateLimitError(429, undefined, 'rate', headers), true],
      [new Anthropic.InternalServerError(500, undefined, 'boom', headers), true],
      [new Anthropic.APIConnectionError({ message: 'down' }), true],
      [new Anthropic.BadRequestError(400, undefined, 'bad', headers), false],
      [new Anthropic.AuthenticationError(401, undefined, 'key', headers), false],
      [new Anthropic.PermissionDeniedError(403, undefined, 'no', headers), false],
    ];
    for (const [err, retryable] of cases) {
      const mapped = mapAnthropicError(err);
      expect(mapped.code).toBe('MODEL_ERROR');
      expect(mapped.retryable).toBe(retryable);
      expect(mapped.transient).toBe(retryable);
    }
  });

  it('surfaces provider errors from planning as MODEL_ERROR', async () => {
    const { client } = fakeClient([
      new Anthropic.RateLimitError(429, undefined, 'rate', new Headers()),
    ]);
    const out = await planTask(
      { config, adapter: createAnthropicAdapter({ client }), route },
      planningInput('x'),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatchObject({ code: 'MODEL_ERROR', retryable: true });
  });

  it('generateObject validates against the zod schema', async () => {
    const { client } = fakeClient([
      message('{"n": "not a number"}', { model: 'claude-haiku-5-5' }),
    ]);
    const res = await createAnthropicAdapter({ client }).generateObject({
      purpose: 'summarize',
      model: 'claude-haiku-5-5',
      effort: 'low',
      maxTokens: 100,
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      schema: z.object({ n: z.number() }),
    });
    expect(res.ok).toBe(false);
  });
});
