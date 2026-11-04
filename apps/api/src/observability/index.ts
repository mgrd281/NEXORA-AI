/**
 * Observability entry point (docs/architecture/phase-b.md §3.10,
 * docs/runbooks/observability.md): tracing (OpenTelemetry, OTLP/HTTP), error
 * reporting (Sentry) and metrics (Prometheus), each on only when configured:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT  → tracing
 *   SENTRY_DSN                   → errors
 *   METRICS_TOKEN                → metrics (/metrics behind the token)
 *
 * All off by default, with nothing loaded (the SDKs are dynamic imports) and
 * every call site a no-op. No content is ever recorded: span attributes,
 * metric labels and error tags are bounded ids and enums, enforced by
 * redact.ts.
 *
 * Call initTelemetry first in a process entry (server.ts, worker.ts) and
 * await `ready` before building the app, so the first requests and jobs are
 * already traced.
 */
import type { Config } from '../config';
import type { Db } from '../db/pool';
import { metricsConfigured, serveMetrics, startMetrics, stopMetrics } from './metrics';
import { errorsConfigured, startSentry, stopSentry } from './sentry';
import { startTracing, stopTracing, tracingConfigured, type TelemetryService } from './tracing';

export {
  addSpanAttributes,
  currentTraceIds,
  logMixin,
  tracingConfigured,
  tracingEnabled,
  withSpan,
  type SpanName,
  type TelemetryService,
} from './tracing';
export {
  metrics,
  metricsConfigured,
  metricsEnabled,
  registerMetricsRoute,
  serveMetrics,
  type JobOutcomeLabel,
  type ModelUsageSample,
  type ToolStatusLabel,
  type WebhookResultLabel,
} from './metrics';
export { captureException, errorsConfigured, errorsEnabled, type CaptureContext } from './sentry';
export { registerHttpInstrumentation, routeLabel } from './http';
export { errorType, pathOnly, sanitizeAttributes, scrubText } from './redact';

export interface Telemetry {
  /** Tracing is configured (OTEL_EXPORTER_OTLP_ENDPOINT). */
  tracing: boolean;
  /** Error reporting is configured (SENTRY_DSN). */
  errors: boolean;
  /** Metrics are configured (METRICS_TOKEN). */
  metrics: boolean;
  /**
   * Resolves once every configured part is loaded and started (immediately
   * when nothing is configured). Never rejects: a part that fails to start
   * is reported on stderr and stays off; the process carries on.
   */
  ready: Promise<void>;
  /** Flushes and stops everything started (idempotent). */
  shutdown(): Promise<void>;
}

export interface TelemetryOptions {
  /**
   * Worker only: serve GET /metrics on this port (same token check). The API
   * serves /metrics on its own HTTP server (registerMetricsRoute).
   */
  metricsPort?: number;
  /** Interface of that listener (default 127.0.0.1). */
  metricsHost?: string;
  /** Database for the queue gauges on that listener (the API reports them already). */
  db?: Db;
}

let current: Telemetry | null = null;

function report(part: string, err: unknown): void {
  // Startup diagnostics only: the error class, never a message that may echo configuration.
  const name = err instanceof Error ? err.name : typeof err;
  console.error(
    JSON.stringify({ level: 'error', msg: `telemetry: ${part} failed to start`, error: name }),
  );
}

/**
 * Starts whatever is configured; idempotent (a second call returns the first
 * Telemetry). Synchronous so it can be the first statement of an entry
 * point; await `ready` before serving.
 */
export function initTelemetry(
  config: Config,
  service: TelemetryService,
  opts: TelemetryOptions = {},
): Telemetry {
  if (current) return current;
  const tracing = tracingConfigured(config);
  const errors = errorsConfigured(config);
  const metricsOn = metricsConfigured(config);
  let listener: { close(): Promise<void> } | null = null;

  const parts: Promise<unknown>[] = [];
  if (tracing)
    parts.push(startTracing(config, service).catch((e: unknown) => report('tracing', e)));
  if (errors) parts.push(startSentry(config, service).catch((e: unknown) => report('errors', e)));
  if (metricsOn) {
    parts.push(
      startMetrics(service, config.APP_VERSION)
        .then(async () => {
          if (opts.metricsPort === undefined) return;
          listener = await serveMetrics(
            { config, db: opts.db },
            { port: opts.metricsPort, host: opts.metricsHost },
          );
        })
        .catch((e: unknown) => report('metrics', e)),
    );
  }
  const ready = Promise.all(parts).then(() => undefined);

  let stopped: Promise<void> | null = null;
  const telemetry: Telemetry = {
    tracing,
    errors,
    metrics: metricsOn,
    ready,
    shutdown() {
      stopped ??= (async () => {
        await ready;
        await Promise.allSettled([stopTracing(), stopSentry(), listener?.close(), stopMetrics()]);
        if (current === telemetry) current = null;
      })();
      return stopped;
    },
  };
  current = telemetry;
  return telemetry;
}
