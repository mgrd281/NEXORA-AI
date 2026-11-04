/**
 * With nothing configured, telemetry loads no SDK, installs no hook and
 * serves no /metrics: every call site is a no-op (phase-b.md §3.10, §9 "O").
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

const loaded = vi.hoisted(() => ({
  sdkNode: false,
  exporter: false,
  resources: false,
  sentry: false,
  prom: false,
}));

// Each factory runs only if something imports the module.
vi.mock('@opentelemetry/sdk-node', () => {
  loaded.sdkNode = true;
  return {};
});
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => {
  loaded.exporter = true;
  return {};
});
vi.mock('@opentelemetry/resources', () => {
  loaded.resources = true;
  return {};
});
vi.mock('@sentry/node', () => {
  loaded.sentry = true;
  return {};
});
vi.mock('prom-client', () => {
  loaded.prom = true;
  return {};
});

import Fastify from 'fastify';
import {
  addSpanAttributes,
  captureException,
  currentTraceIds,
  initTelemetry,
  logMixin,
  metrics,
  metricsEnabled,
  registerHttpInstrumentation,
  tracingEnabled,
  withSpan,
} from '../../../src/observability';
import { fakeDb, obsConfig, testApp } from './support';

describe('telemetry with nothing configured', () => {
  const telemetry = initTelemetry(obsConfig(), 'api');
  afterAll(() => telemetry.shutdown());

  it('reports every part off and is ready at once', async () => {
    expect(telemetry).toMatchObject({ tracing: false, errors: false, metrics: false });
    await telemetry.ready;
    expect(tracingEnabled()).toBe(false);
    expect(metricsEnabled()).toBe(false);
  });

  it('is idempotent', () => {
    expect(initTelemetry(obsConfig(), 'worker')).toBe(telemetry);
  });

  it('makes every call site a no-op', async () => {
    await expect(withSpan('job', { 'jarvis.job.kind': 'task.plan' }, async () => 7)).resolves.toBe(
      7,
    );
    await expect(
      withSpan('tool.execute', {}, async () => {
        throw new Error('passes through');
      }),
    ).rejects.toThrow('passes through');
    addSpanAttributes({ 'gen_ai.usage.input_tokens': 1 });
    expect(currentTraceIds()).toBeNull();
    expect(logMixin()).toEqual({});
    metrics.httpRequest('listTasks', 'GET', 200, 3);
    metrics.jobFinished('task.plan', 'succeeded', 10);
    metrics.toolExecution('web.fetch', 'failed', 10);
    metrics.modelUsage({
      model: 'm',
      purpose: 'planning',
      inputTokens: 1,
      outputTokens: 1,
      costMicro: 1,
    });
    metrics.sseStreams(1);
    metrics.sseStreams(-1);
    metrics.webhookDelivery('retry');
    captureException(new Error('nobody hears this'), { requestId: 'r1' });
  });

  it('installs no Fastify hook', () => {
    const app = Fastify();
    const addHook = vi.spyOn(app, 'addHook');
    registerHttpInstrumentation(app, obsConfig());
    expect(addHook).not.toHaveBeenCalled();
  });

  it('serves no /metrics (404), while the app works as before', async () => {
    // (A bearer token is looked up as a session first: the fake database has none.)
    const app = await testApp(obsConfig(), { db: fakeDb().db });
    try {
      const m = await app.inject({
        url: '/metrics',
        headers: { authorization: 'Bearer whatever' },
      });
      expect(m.statusCode).toBe(404);
      const ok = await app.inject({ url: '/v1/things/1' });
      expect(ok.statusCode).toBe(200);
      const boom = await app.inject({ url: '/v1/boom' });
      expect(boom.statusCode).toBe(500);
      expect(boom.json().error.code).toBe('INTERNAL');
    } finally {
      await app.close();
    }
  });

  it('loaded none of the SDKs', () => {
    expect(loaded).toEqual({
      sdkNode: false,
      exporter: false,
      resources: false,
      sentry: false,
      prom: false,
    });
  });

  it('would notice a load (control: the mocks do record imports)', async () => {
    await import('prom-client');
    expect(loaded.prom).toBe(true);
  });
});
