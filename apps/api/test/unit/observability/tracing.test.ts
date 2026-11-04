/**
 * Tracing on (an in-memory span processor in place of the OTLP exporter):
 * job/tool/model spans, HTTP server spans, W3C context continuation, log
 * correlation — and no content in any attribute or event.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addSpanAttributes, currentTraceIds, logMixin, withSpan } from '../../../src/observability';
import {
  startTracing,
  stopTracing,
  tracesUrl,
  tracingEnabled,
  type SpanProcessorLike,
} from '../../../src/observability/tracing';
import { fakeDb, obsConfig, testApp } from './support';

interface RecordedSpan {
  name: string;
  kind: number;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
  events: { name: string; attributes?: Record<string, unknown> }[];
  parentSpanContext?: { spanId: string; traceId: string };
  spanContext(): { traceId: string; spanId: string };
}

class MemoryProcessor implements SpanProcessorLike {
  spans: RecordedSpan[] = [];
  onStart(): void {}
  onEnd(span: unknown): void {
    this.spans.push(span as RecordedSpan);
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
  named(name: string): RecordedSpan[] {
    return this.spans.filter((s) => s.name === name);
  }
}

const processor = new MemoryProcessor();
const config = obsConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1/unused' });

beforeAll(async () => {
  await startTracing(config, 'api', { spanProcessors: [processor] });
});
afterAll(() => stopTracing());
beforeEach(() => {
  processor.spans = [];
});

/** Everything a span would export, as one string (for "no content" assertions). */
const exported = (s: RecordedSpan) =>
  JSON.stringify({ name: s.name, attributes: s.attributes, status: s.status, events: s.events });

describe('withSpan', () => {
  it('records a span with sanitised attributes and nests children', async () => {
    expect(tracingEnabled()).toBe(true);
    const result = await withSpan(
      'job',
      { 'jarvis.job.kind': 'task.execute', 'jarvis.job.id': 7, 'jarvis.task.title': 'Secret plan' },
      () =>
        withSpan(
          'tool.execute',
          { 'jarvis.tool.id': 'email.send', 'jarvis.note': 'mail bob@example.com' },
          async () => 'done',
        ),
    );
    expect(result).toBe('done');
    const [job] = processor.named('job');
    const [tool] = processor.named('tool.execute');
    expect(job!.attributes).toEqual({ 'jarvis.job.kind': 'task.execute', 'jarvis.job.id': 7 });
    expect(tool!.attributes).toEqual({ 'jarvis.tool.id': 'email.send' });
    expect(tool!.parentSpanContext?.spanId).toBe(job!.spanContext().spanId);
    expect(tool!.spanContext().traceId).toBe(job!.spanContext().traceId);
  });

  it('marks errors by type only — no message, no exception event', async () => {
    const err = Object.assign(
      new Error('could not reach https://example.com/?q=diary for anna@example.com'),
      {
        code: 'FETCH_FAILED',
      },
    );
    await expect(
      withSpan('tool.execute', { 'jarvis.tool.id': 'web.fetch' }, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    const [span] = processor.named('tool.execute');
    expect(span!.status.code).toBe(2); // ERROR
    expect(span!.status.message).toBeUndefined();
    expect(span!.attributes['error.type']).toBe('FETCH_FAILED');
    expect(span!.events).toEqual([]);
    expect(exported(span!)).not.toMatch(/example\.com|diary|anna/);
  });

  it('model.call: token counts added after the call, never prompt or output', async () => {
    await withSpan(
      'model.call',
      {
        'gen_ai.request.model': 'claude-opus-5-5',
        'jarvis.model.purpose': 'planning',
        'gen_ai.prompt': 'my diary',
      },
      async () => {
        addSpanAttributes({
          'gen_ai.usage.input_tokens': 2_000,
          'gen_ai.usage.output_tokens': 600,
          'gen_ai.response.finish_reasons': 'end_turn',
          'gen_ai.completion': 'the plan text',
        });
      },
    );
    const [span] = processor.named('model.call');
    expect(span!.kind).toBe(2); // CLIENT
    expect(span!.attributes).toEqual({
      'gen_ai.request.model': 'claude-opus-5-5',
      'jarvis.model.purpose': 'planning',
      'gen_ai.usage.input_tokens': 2_000,
      'gen_ai.usage.output_tokens': 600,
      'gen_ai.response.finish_reasons': 'end_turn',
    });
  });

  it('exposes the active trace ids to logs', async () => {
    let ids = null as ReturnType<typeof currentTraceIds>;
    let mixin: Record<string, string> = {};
    await withSpan('scheduler.tick', {}, async () => {
      ids = currentTraceIds();
      mixin = logMixin();
    });
    const [span] = processor.named('scheduler.tick');
    expect(ids).toEqual({
      traceId: span!.spanContext().traceId,
      spanId: span!.spanContext().spanId,
    });
    expect(mixin).toEqual({
      trace_id: span!.spanContext().traceId,
      span_id: span!.spanContext().spanId,
    });
    expect(currentTraceIds()).toBeNull();
  });
});

describe('HTTP server spans', () => {
  let app: Awaited<ReturnType<typeof testApp>>;
  beforeAll(async () => {
    app = await testApp(config, { db: fakeDb().db });
  });
  afterAll(() => app.close());

  it('one SERVER span per request, named by route template, without URL, query or headers', async () => {
    const res = await app.inject({
      url: '/v1/things/0f8fad5b-d9cb-469f-a165-70867728950e?q=my+private+search',
      headers: { 'user-agent': 'Secret-Agent/1.0', 'x-request-id': 'req-abcdef12', cookie: 'a=b' },
    });
    expect(res.statusCode).toBe(200);
    const [span] = processor.named('GET /v1/things/:id');
    expect(span!.kind).toBe(1); // SERVER
    expect(span!.attributes).toEqual({
      'http.request.method': 'GET',
      'http.route': '/v1/things/:id',
      'jarvis.route': 'getThing',
      'jarvis.request_id': 'req-abcdef12',
      'http.response.status_code': 200,
    });
    expect(exported(span!)).not.toMatch(/0f8fad5b|private|Secret-Agent|a=b/);
  });

  it('continues an incoming W3C trace context', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    await app.inject({
      url: '/v1/things/1',
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });
    const [span] = processor.named('GET /v1/things/:id');
    expect(span!.spanContext().traceId).toBe(traceId);
    expect(span!.parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
  });

  it('runs the handler inside the request span (child spans, log correlation)', async () => {
    // Assigned inside the handler: typed by assertion so TypeScript does not narrow it to null.
    let seen = null as ReturnType<typeof currentTraceIds>;
    const local = await testApp(config, {
      db: fakeDb().db,
      routes: (a) =>
        a.get('/v1/child', { config: { routeName: 'child' } }, async () => {
          seen = currentTraceIds();
          await withSpan('storage.op', { 'jarvis.storage.op': 'get' }, async () => {});
          return { ok: true };
        }),
    });
    try {
      await local.inject({ url: '/v1/child' });
    } finally {
      await local.close();
    }
    const [server] = processor.named('GET /v1/child');
    const [child] = processor.named('storage.op');
    expect(seen?.spanId).toBe(server!.spanContext().spanId);
    expect(child!.parentSpanContext?.spanId).toBe(server!.spanContext().spanId);
  });

  it('marks 5xx responses as errors; unmatched routes get a fixed name', async () => {
    await app.inject({ url: '/v1/boom' });
    await app.inject({ url: '/v1/nowhere/someone@example.com' });
    const [boom] = processor.named('GET /v1/boom');
    expect(boom!.status.code).toBe(2);
    expect(boom!.attributes['http.response.status_code']).toBe(500);
    const [missing] = processor.named('GET __unmatched');
    expect(missing!.attributes['http.route']).toBe('__unmatched');
    expect(exported(missing!)).not.toContain('someone');
  });
});

describe('tracesUrl', () => {
  it('appends the OTLP/HTTP traces path to the base endpoint', () => {
    expect(tracesUrl('http://collector:4318')).toBe('http://collector:4318/v1/traces');
    expect(tracesUrl('https://otel.example.com/otlp/')).toBe(
      'https://otel.example.com/otlp/v1/traces',
    );
  });
});
