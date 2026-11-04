/**
 * HTTP instrumentation for the API (Fastify hooks).
 *
 * Only what is configured is installed: with neither tracing nor metrics
 * configured this registers nothing at all, so requests run exactly as
 * without it. Tracing: one SERVER span per request named "<METHOD> <route
 * template>", continuing an incoming W3C traceparent, with the request
 * method, route template, contract route name, status code and request id —
 * never the URL, query string, headers or body. Metrics: the latency
 * histogram by contract route name, method and status.
 */
import type { Span } from '@opentelemetry/api';
import { context, SpanStatusCode } from '@opentelemetry/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { metrics, metricsConfigured } from './metrics';
import { startServerSpan, tracingConfigured, tracingEnabled } from './tracing';

/** Label of requests that matched no route (404s), so raw paths never become labels. */
export const UNMATCHED_ROUTE = '__unmatched';

/** The contract route name of a request, else its route template, else UNMATCHED_ROUTE. */
export function routeLabel(req: FastifyRequest): string {
  const opts = req.routeOptions as { config?: { routeName?: unknown }; url?: string } | undefined;
  const name = opts?.config?.routeName;
  if (typeof name === 'string') return name;
  return opts?.url ?? UNMATCHED_ROUTE;
}

const spans = new WeakMap<FastifyRequest, Span>();

export function registerHttpInstrumentation(
  app: FastifyInstance,
  config: Pick<Config, 'OTEL_EXPORTER_OTLP_ENDPOINT' | 'METRICS_TOKEN'>,
): void {
  const traced = tracingConfigured(config);
  const measured = metricsConfigured(config);
  if (!traced && !measured) return;

  if (traced) {
    // Callback style: `done` runs inside the span's context, so the hooks
    // and the handler after it (and their logs and child spans) belong to it.
    app.addHook('onRequest', (req, _reply, done) => {
      if (!tracingEnabled()) return done();
      const template = req.routeOptions?.url;
      const { span, ctx } = startServerSpan(
        `${req.method} ${template ?? UNMATCHED_ROUTE}`,
        req.headers,
        {
          'http.request.method': req.method,
          'http.route': template ?? UNMATCHED_ROUTE,
          'jarvis.route': routeLabel(req),
          'jarvis.request_id': req.id,
        },
      );
      spans.set(req, span);
      context.with(ctx, done);
    });
    // The client went away before a response (long polls, SSE): end the span anyway.
    app.addHook('onRequestAbort', async (req) => {
      const span = spans.get(req);
      if (!span) return;
      spans.delete(req);
      span.setAttribute('jarvis.aborted', true);
      span.end();
    });
  }

  app.addHook('onResponse', async (req, reply) => {
    if (measured)
      metrics.httpRequest(routeLabel(req), req.method, reply.statusCode, reply.elapsedTime);
    const span = spans.get(req);
    if (span) {
      spans.delete(req);
      span.setAttribute('http.response.status_code', reply.statusCode);
      if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
  });
}
