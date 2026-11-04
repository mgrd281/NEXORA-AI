/**
 * Prometheus metrics with METRICS_TOKEN set: the token-protected /metrics
 * endpoint, bounded labels (route names, never paths), queue gauges read on
 * scrape, and the worker's own listener.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initTelemetry, metrics, metricsEnabled, serveMetrics } from '../../../src/observability';
import { metricsAuthorized } from '../../../src/observability/metrics';
import { fakeDb, METRICS_TOKEN, obsConfig, testApp } from './support';

const config = obsConfig({ METRICS_TOKEN, APP_VERSION: '1.2.3' });
const telemetry = initTelemetry(config, 'api');
const queueRow = { ready: '3', scheduled: '2', running: '1', oldest: '12.5' };
const { db, queries } = fakeDb((text) => (text.includes('FROM jobs') ? [queueRow] : []));
let app: Awaited<ReturnType<typeof testApp>>;

const auth = { authorization: `Bearer ${METRICS_TOKEN}` };

beforeAll(async () => {
  await telemetry.ready;
  app = await testApp(config, { db });
});
afterAll(async () => {
  await app.close();
  await telemetry.shutdown();
});

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Samples of the text exposition format (label order does not matter). */
function samples(body: string): Sample[] {
  const out: Sample[] = [];
  for (const line of body.split('\n')) {
    const m = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const l of (m[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]!] = l[2]!;
    out.push({ name: m[1]!, labels, value: Number(m[3]) });
  }
  return out;
}

/** The value of the sample `name` whose labels include `labels` (service="api" implied). */
function value(
  body: string,
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  const want = { service: 'api', ...labels };
  return samples(body).find(
    (s) => s.name === name && Object.entries(want).every(([k, v]) => s.labels[k] === v),
  )?.value;
}

async function scrape(): Promise<string> {
  const res = await app.inject({ url: '/metrics', headers: auth });
  expect(res.statusCode).toBe(200);
  return res.body;
}

describe('/metrics', () => {
  it('is on', () => {
    expect(telemetry.metrics).toBe(true);
    expect(metricsEnabled()).toBe(true);
  });

  it('refuses requests without the token, or with a wrong one', async () => {
    const none = await app.inject({ url: '/metrics' });
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    expect(none.body).not.toContain('jarvis_');
    const wrong = await app.inject({ url: '/metrics', headers: { authorization: 'Bearer nope' } });
    expect(wrong.statusCode).toBe(401);
    const basic = await app.inject({
      url: '/metrics',
      headers: { authorization: `Basic ${METRICS_TOKEN}` },
    });
    expect(basic.statusCode).toBe(401);
  });

  it('serves the Prometheus text format, uncached', async () => {
    const res = await app.inject({ url: '/metrics', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(value(res.body, 'jarvis_build_info', { version: '1.2.3' })).toBe(1);
    expect(res.body).toContain('process_cpu_user_seconds_total');
  });

  it('labels request latency by contract route name, never by path', async () => {
    await app.inject({ url: '/v1/things/0f8fad5b-d9cb-469f-a165-70867728950e?q=private' });
    await app.inject({ url: '/v1/nowhere/secret-path' });
    await app.inject({ url: '/v1/boom' });
    const body = await scrape();
    const count = 'jarvis_http_request_duration_seconds_count';
    expect(value(body, count, { route: 'getThing', method: 'GET', status: '200' })).toBe(1);
    expect(value(body, count, { route: '__unmatched', method: 'GET', status: '404' })).toBe(1);
    expect(value(body, count, { route: 'boom', method: 'GET', status: '500' })).toBe(1);
    expect(body).not.toMatch(/0f8fad5b|private|secret-path|\/v1\/things/);
  });

  it('reads the queue gauges from the database on every scrape', async () => {
    const before = queries.length;
    const body = await scrape();
    expect(queries.length).toBeGreaterThan(before);
    expect(queries.at(-1)).toContain('FROM jobs');
    expect(value(body, 'jarvis_queue_jobs', { state: 'ready' })).toBe(3);
    expect(value(body, 'jarvis_queue_jobs', { state: 'scheduled' })).toBe(2);
    expect(value(body, 'jarvis_queue_jobs', { state: 'running' })).toBe(1);
    expect(value(body, 'jarvis_queue_oldest_ready_seconds')).toBe(12.5);
  });

  it('records jobs, tools, model usage, SSE streams and webhook deliveries', async () => {
    metrics.jobFinished('task.execute', 'succeeded', 1_500);
    metrics.jobFinished('task.execute', 'dead', 20);
    metrics.toolExecution('web.fetch', 'failed', 250);
    metrics.modelUsage({
      model: 'claude-haiku-5-5',
      purpose: 'summarize',
      inputTokens: 1_000,
      outputTokens: 200,
      costMicro: 1_800,
    });
    metrics.sseStreams(1);
    metrics.sseStreams(1);
    metrics.sseStreams(-1);
    metrics.webhookDelivery('retry');
    const body = await scrape();
    const job = { kind: 'task.execute', outcome: 'succeeded' };
    expect(value(body, 'jarvis_job_duration_seconds_count', job)).toBe(1);
    expect(value(body, 'jarvis_job_duration_seconds_sum', job)).toBe(1.5);
    expect(value(body, 'jarvis_job_duration_seconds_count', { ...job, outcome: 'dead' })).toBe(1);
    expect(
      value(body, 'jarvis_tool_executions_total', { tool: 'web.fetch', status: 'failed' }),
    ).toBe(1);
    expect(
      value(body, 'jarvis_tool_execution_duration_seconds_sum', {
        tool: 'web.fetch',
        status: 'failed',
      }),
    ).toBe(0.25);
    const model = { model: 'claude-haiku-5-5', purpose: 'summarize' };
    expect(value(body, 'jarvis_model_calls_total', model)).toBe(1);
    expect(value(body, 'jarvis_model_tokens_total', { ...model, direction: 'input' })).toBe(1000);
    expect(value(body, 'jarvis_model_tokens_total', { ...model, direction: 'output' })).toBe(200);
    expect(value(body, 'jarvis_model_cost_usd_total', model)).toBeCloseTo(0.0018, 10);
    expect(value(body, 'jarvis_sse_streams')).toBe(1);
    expect(value(body, 'jarvis_webhook_deliveries_total', { result: 'retry' })).toBe(1);
  });

  it('never turns content into a label', async () => {
    metrics.modelUsage({
      model: 'https://evil.test/?q=x',
      purpose: 'summarize this private text',
      inputTokens: Number.NaN,
      outputTokens: -5,
      costMicro: Number.POSITIVE_INFINITY,
    });
    metrics.httpRequest('/v1/tasks/someone@example.com', 'GET', 200, 1);
    const body = await scrape();
    expect(body).not.toMatch(/evil\.test|private text|someone@example\.com/);
    expect(value(body, 'jarvis_model_calls_total', { model: 'other', purpose: 'other' })).toBe(1);
    // NaN / negative / infinite counts add nothing (a counter can only grow by finite amounts).
    expect(value(body, 'jarvis_model_tokens_total', { model: 'other', direction: 'input' })).toBe(
      0,
    );
  });

  it('still answers when the queue gauges cannot be read', async () => {
    const broken = fakeDb((text) => {
      if (text.includes('FROM jobs')) throw new Error('db down');
      return [];
    });
    const other = await testApp(config, { db: broken.db });
    try {
      const res = await other.inject({ url: '/metrics', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(value(res.body, 'jarvis_metrics_scrape_errors_total')).toBeGreaterThan(0);
    } finally {
      await other.close();
    }
  });
});

describe('metricsAuthorized', () => {
  it('accepts only the exact bearer token', () => {
    expect(metricsAuthorized(METRICS_TOKEN, `Bearer ${METRICS_TOKEN}`)).toBe(true);
    expect(metricsAuthorized(METRICS_TOKEN, `Bearer ${METRICS_TOKEN}x`)).toBe(false);
    expect(metricsAuthorized(METRICS_TOKEN, `Bearer ${METRICS_TOKEN.slice(1)}`)).toBe(false);
    expect(metricsAuthorized(METRICS_TOKEN, METRICS_TOKEN)).toBe(false);
    expect(metricsAuthorized(METRICS_TOKEN, 'Bearer ')).toBe(false);
    expect(metricsAuthorized(METRICS_TOKEN, undefined)).toBe(false);
    expect(metricsAuthorized(METRICS_TOKEN, [`Bearer ${METRICS_TOKEN}`])).toBe(true);
  });
});

describe('serveMetrics (worker listener)', () => {
  it('serves only GET /metrics, behind the token', async () => {
    const server = await serveMetrics({ config }, { port: 0 });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${base}/other`, { headers: auth })).status).toBe(404);
      expect((await fetch(`${base}/metrics`)).status).toBe(401);
      const ok = await fetch(`${base}/metrics`, { headers: auth });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain('jarvis_job_duration_seconds');
    } finally {
      await server.close();
    }
  });

  it('needs a token to start', async () => {
    await expect(serveMetrics({ config: obsConfig() }, { port: 0 })).rejects.toThrow(
      /METRICS_TOKEN/,
    );
  });
});
