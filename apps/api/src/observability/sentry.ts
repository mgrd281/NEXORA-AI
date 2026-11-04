/**
 * Error reporting to Sentry, on only when SENTRY_DSN is set (loaded with a
 * dynamic import; off, nothing of the SDK is loaded and captureException is
 * a null check).
 *
 * Privacy (docs/runbooks/observability.md): no default integrations — none of
 * the request-data, HTTP/console breadcrumb, local-variable or performance
 * integrations run. Only error capture, linked causes, dedupe, uncaught
 * exceptions and rejections (Node's own crash behaviour kept: 'strict') and
 * runtime context are installed (no source context lines: stack frames carry
 * file, function and line only). dataCollection collects nothing about users,
 * headers, cookies, bodies, queries or variables, breadcrumbs are
 * dropped, transactions are never sent, and every event passes
 * scrubSentryEvent (redact.ts) in beforeSend: no request bodies, cookies,
 * auth headers, query strings, user email or IP, extras or local variables;
 * exception messages are scrubbed of addresses, links and credentials.
 */
import type { Config } from '../config';
import { sanitizeAttributes, scrubSentryEvent, type ScrubbableEvent } from './redact';
import { currentTraceIds, type TelemetryService } from './tracing';

type SentryModule = typeof import('@sentry/node');

let sentry: SentryModule | null = null;

export interface CaptureContext {
  requestId?: string;
  route?: string;
  jobId?: number;
  jobKind?: string;
}

export function errorsConfigured(config: Pick<Config, 'SENTRY_DSN'>): boolean {
  return !!config.SENTRY_DSN;
}

export function errorsEnabled(): boolean {
  return sentry !== null;
}

/**
 * Loads and initialises the SDK. `transport` replaces the network transport
 * (tests capture envelopes with it).
 */
export async function startSentry(
  config: Pick<Config, 'SENTRY_DSN' | 'SENTRY_ENVIRONMENT' | 'NODE_ENV' | 'APP_VERSION'>,
  service: TelemetryService,
  opts: { transport?: unknown } = {},
): Promise<boolean> {
  if (sentry) return true;
  if (!config.SENTRY_DSN) return false;
  const S = await import('@sentry/node');
  S.initWithoutDefaultIntegrations({
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
    release: `jarvis@${config.APP_VERSION}`,
    maxBreadcrumbs: 0,
    // Collect nothing about users, requests, queries or variables in the first place.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    integrations: [
      S.linkedErrorsIntegration(),
      S.dedupeIntegration(),
      S.functionToStringIntegration(),
      S.onUncaughtExceptionIntegration(),
      S.onUnhandledRejectionIntegration({ mode: 'strict' }),
      S.nodeContextIntegration(),
    ],
    beforeBreadcrumb: () => null,
    beforeSendTransaction: () => null,
    beforeSend: (event) =>
      scrubSentryEvent(event as unknown as ScrubbableEvent) as unknown as typeof event,
    initialScope: { tags: { service } },
    ...(opts.transport ? { transport: opts.transport as never } : {}),
  });
  sentry = S;
  return true;
}

/** Flushes pending events (up to `timeoutMs`) and closes the client. */
export async function stopSentry(timeoutMs = 2_000): Promise<void> {
  const S = sentry;
  sentry = null;
  if (S) await S.close(timeoutMs);
}

/**
 * Reports an unexpected error (5xx in the API, a failed job in the worker)
 * with bounded tags only: request id, route name, job id and kind, and the
 * trace id when tracing is on. A no-op without SENTRY_DSN.
 */
export function captureException(err: unknown, context: CaptureContext = {}): void {
  const S = sentry;
  if (!S) return;
  const ids = currentTraceIds();
  const tags = sanitizeAttributes({
    'jarvis.request_id': context.requestId,
    'jarvis.route': context.route,
    'jarvis.job_id': context.jobId,
    'jarvis.job_kind': context.jobKind,
    trace_id: ids?.traceId,
  });
  S.withScope((scope) => {
    for (const [key, value] of Object.entries(tags)) scope.setTag(key, value);
    S.captureException(err);
  });
}
