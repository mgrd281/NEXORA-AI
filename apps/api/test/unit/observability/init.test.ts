/**
 * initTelemetry with everything configured: each part starts (real SDKs,
 * unreachable endpoints, nothing exported), `ready` resolves, shutdown stops
 * them and is idempotent; a part that cannot start stays off without failing
 * the process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  errorsEnabled,
  initTelemetry,
  metricsEnabled,
  tracingEnabled,
} from '../../../src/observability';
import { METRICS_TOKEN, obsConfig } from './support';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('initTelemetry', () => {
  it('starts tracing, errors and metrics when configured and stops them on shutdown', async () => {
    const telemetry = initTelemetry(
      obsConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9/otlp',
        SENTRY_DSN: 'https://public@o0.ingest.sentry.invalid/1',
        METRICS_TOKEN,
      }),
      'worker',
    );
    expect(telemetry).toMatchObject({ tracing: true, errors: true, metrics: true });
    await telemetry.ready;
    expect(tracingEnabled()).toBe(true);
    expect(errorsEnabled()).toBe(true);
    expect(metricsEnabled()).toBe(true);
    await telemetry.shutdown();
    await telemetry.shutdown();
    expect(tracingEnabled()).toBe(false);
    expect(errorsEnabled()).toBe(false);
    expect(metricsEnabled()).toBe(false);
  });

  it('serves the worker listener when given a port, and closes it on shutdown', async () => {
    const telemetry = initTelemetry(obsConfig({ METRICS_TOKEN }), 'worker', { metricsPort: 0 });
    await telemetry.ready;
    expect(metricsEnabled()).toBe(true);
    await telemetry.shutdown();
    expect(metricsEnabled()).toBe(false);
  });

  it('keeps the process going when a part cannot start', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('@opentelemetry/sdk-node', () => {
      throw new Error('cannot load');
    });
    const telemetry = initTelemetry(
      obsConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' }),
      'api',
    );
    await expect(telemetry.ready).resolves.toBeUndefined();
    expect(tracingEnabled()).toBe(false);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('telemetry: tracing failed to start'),
    );
    await telemetry.shutdown();
    vi.doUnmock('@opentelemetry/sdk-node');
  });
});
