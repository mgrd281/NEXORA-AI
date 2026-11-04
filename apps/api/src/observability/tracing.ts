/**
 * OpenTelemetry tracing, on only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 *
 * Off (the default) nothing of the SDK is loaded: only @opentelemetry/api,
 * the vendor-neutral no-op facade, is imported, and withSpan is a plain call
 * of its function. On, the Node SDK is loaded with a dynamic import and
 * exports spans over OTLP/HTTP to `<endpoint>/v1/traces`.
 *
 * Spans carry only bounded attributes (route names, tool ids, job kinds,
 * model ids, status codes, token counts): every attribute passes
 * sanitizeAttributes (redact.ts), and errors are recorded by type, never by
 * message. No auto-instrumentation is installed: the HTTP instrumentation
 * would record full URLs (query strings carry search text) of incoming
 * requests and of outgoing ones (fetched pages, webhook endpoints).
 */
import {
  context,
  isSpanContextValid,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { hostname } from 'node:os';
import type { Config } from '../config';
import { errorType, sanitizeAttributes } from './redact';

/** The spans JARVIS creates besides one per HTTP request (phase-b.md §3.10). */
export type SpanName =
  | 'job'
  | 'tool.execute'
  | 'model.call'
  | 'scheduler.tick'
  | 'retention.sweep'
  | 'webhook.deliver'
  | 'storage.op'
  | 'document.extract';

export type TelemetryService = 'api' | 'worker';

/**
 * A span processor (structurally @opentelemetry/sdk-trace's SpanProcessor).
 * Tests pass an in-memory one instead of the OTLP exporter.
 */
export interface SpanProcessorLike {
  onStart(span: unknown, parentContext: unknown): void;
  onEnd(span: unknown): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

const TRACER_NAME = 'jarvis';
/** Spans that call out of the process. */
const CLIENT_SPANS = new Set<SpanName>(['model.call', 'webhook.deliver', 'storage.op']);

let enabled = false;
let sdk: { shutdown(): Promise<void> } | null = null;

export function tracingConfigured(config: Pick<Config, 'OTEL_EXPORTER_OTLP_ENDPOINT'>): boolean {
  return !!config.OTEL_EXPORTER_OTLP_ENDPOINT;
}

/** Whether spans are being recorded right now (the SDK is loaded and started). */
export function tracingEnabled(): boolean {
  return enabled;
}

export function serviceName(
  config: Pick<Config, 'OTEL_SERVICE_NAME'>,
  service: TelemetryService,
): string {
  return config.OTEL_SERVICE_NAME ?? `jarvis-${service}`;
}

/** OTEL_EXPORTER_OTLP_ENDPOINT is the base URL; OTLP/HTTP traces go to <base>/v1/traces. */
export function tracesUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/traces`;
}

/**
 * Loads and starts the Node SDK. Resolves false (and does nothing) when
 * tracing is not configured and no test processor is given. Only traces are
 * set up: the SDK's own metric and log exporters (which it would otherwise
 * enable from OTEL_* defaults) are switched off, and resource detection is
 * limited to the attributes set here (no command line, no host details).
 * Sampling follows OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG (default:
 * parent-based, always on).
 */
export async function startTracing(
  config: Pick<
    Config,
    'OTEL_EXPORTER_OTLP_ENDPOINT' | 'OTEL_SERVICE_NAME' | 'APP_VERSION' | 'NODE_ENV'
  >,
  service: TelemetryService,
  opts: { spanProcessors?: SpanProcessorLike[] } = {},
): Promise<boolean> {
  if (enabled) return true;
  if (!config.OTEL_EXPORTER_OTLP_ENDPOINT && !opts.spanProcessors) return false;
  const [{ NodeSDK }, { resourceFromAttributes }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/resources'),
  ]);
  const name = serviceName(config, service);
  let processing: Record<string, unknown>;
  if (opts.spanProcessors) {
    processing = { spanProcessors: opts.spanProcessors };
  } else {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    processing = {
      traceExporter: new OTLPTraceExporter({ url: tracesUrl(config.OTEL_EXPORTER_OTLP_ENDPOINT!) }),
    };
  }
  const instance = new NodeSDK({
    serviceName: name,
    resource: resourceFromAttributes({
      'service.name': name,
      'service.version': config.APP_VERSION,
      'service.instance.id': `${hostname()}:${process.pid}`,
      'deployment.environment.name': config.NODE_ENV,
    }),
    autoDetectResources: false,
    instrumentations: [],
    metricReaders: [],
    logRecordProcessors: [],
    ...processing,
  });
  instance.start();
  sdk = instance;
  enabled = true;
  return true;
}

/** Flushes and stops the SDK and unregisters it, so a later start begins clean. */
export async function stopTracing(): Promise<void> {
  const current = sdk;
  enabled = false;
  sdk = null;
  if (!current) return;
  try {
    await current.shutdown();
  } finally {
    trace.disable();
    context.disable();
    propagation.disable();
  }
}

/**
 * Runs `fn` inside a span named `name` (a child of the active span). With
 * tracing off it is exactly `fn()`. Attributes are sanitised; a thrown error
 * marks the span ERROR with `error.type` (its code or class) and is rethrown.
 */
export function withSpan<T>(
  name: SpanName,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled) return fn();
  return trace.getTracer(TRACER_NAME).startActiveSpan(
    name,
    {
      kind: CLIENT_SPANS.has(name) ? SpanKind.CLIENT : SpanKind.INTERNAL,
      attributes: sanitizeAttributes(attributes),
    },
    async (span) => {
      try {
        return await fn();
      } catch (err) {
        markError(span, err);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Adds attributes to the active span (sanitised), e.g. token counts that are
 * known only after a model call returned. A no-op with tracing off.
 */
export function addSpanAttributes(attributes: Record<string, string | number | boolean>): void {
  if (!enabled) return;
  trace.getActiveSpan()?.setAttributes(sanitizeAttributes(attributes));
}

/** Trace and span id of the active span (log correlation), or null. */
export function currentTraceIds(): { traceId: string; spanId: string } | null {
  if (!enabled) return null;
  const span = trace.getActiveSpan();
  if (!span) return null;
  const c = span.spanContext();
  return isSpanContextValid(c) ? { traceId: c.traceId, spanId: c.spanId } : null;
}

/** Pino mixin: `trace_id` / `span_id` of the active span on every log line. */
export function logMixin(): Record<string, string> {
  const ids = currentTraceIds();
  return ids ? { trace_id: ids.traceId, span_id: ids.spanId } : {};
}

export function markError(span: Span, err: unknown): void {
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.setAttribute('error.type', errorType(err));
}

/**
 * Starts the server span of an HTTP request, continuing a W3C trace context
 * the caller sent (traceparent). Returns the span and the context to run the
 * rest of the request in.
 */
export function startServerSpan(
  name: string,
  headers: Record<string, string | string[] | undefined>,
  attributes: Attributes,
): { span: Span; ctx: Context } {
  const parent = propagation.extract(context.active(), headers);
  const span = trace.getTracer(TRACER_NAME).startSpan(
    name,
    {
      kind: SpanKind.SERVER,
      attributes: sanitizeAttributes(attributes as Record<string, unknown>),
    },
    parent,
  );
  return { span, ctx: trace.setSpan(parent, span) };
}
