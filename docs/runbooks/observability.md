# Observability runbook

Tracing (OpenTelemetry), error reporting (Sentry) and metrics (Prometheus) for the API and the
worker. Code: `apps/api/src/observability/`. Design: [Phase B §3.10](../architecture/phase-b.md#310-observability).

**Everything is off by default.** Each part is switched on by one environment variable and loads its
SDK only then (dynamic imports). Off, no SDK module is loaded, no Fastify hook is installed and every
call site is a single null check (unit-tested, benchmarked below).

| Part    | Turned on by                                          | What it sends / serves                                        |
| ------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| Tracing | `OTEL_EXPORTER_OTLP_ENDPOINT` (+ `OTEL_SERVICE_NAME`) | spans over OTLP/HTTP (JSON) to `<endpoint>/v1/traces`         |
| Errors  | `SENTRY_DSN` (+ `SENTRY_ENVIRONMENT`)                 | 5xx errors and failed jobs, scrubbed, to Sentry               |
| Metrics | `METRICS_TOKEN` (≥ 24 characters)                     | `GET /metrics` (Prometheus text format) behind a bearer token |

## Privacy: no content in telemetry

Span attributes, metric labels and error reports carry only bounded identifiers and enums: route
names and templates, HTTP methods and status codes, job kinds and outcomes, tool ids and statuses,
model ids and purposes, token counts, request/trace ids. Never: prompts, model output, page or
document text, email addresses, subjects or bodies, memories, file names, URLs, query strings,
headers, cookies or IP addresses.

This is enforced twice — call sites pass only such values, and `observability/redact.ts` checks
everything on the way out:

- **Spans** (`sanitizeAttributes`): keys with a content segment (`url`, `query`, `email`, `subject`,
  `body`, `text`, `prompt`, `completion`, `title`, `filename`, `host`, `header`, `cookie`, `token`,
  `secret`, …) are dropped; string values must look like an id or enum (no whitespace, `@`, `?`, `=`,
  `&`, `%`, `#`, `://`; ≤ 128 chars) or become `[redacted]`; at most 32 attributes. Errors are recorded
  as `error.type` (the error's code or class) — never the message, never an exception event. HTTP
  server spans are named `<METHOD> <route template>` and record method, route template, contract route
  name, status and request id only.
- **Metrics** (`labelValue`): label values that are not ids or enums become `other`; HTTP requests
  are labelled by contract route name (or route template), unmatched paths by `__unmatched`.
- **Sentry**: initialised without default integrations (no request-data, HTTP/console breadcrumb,
  local-variable, source-context or performance integrations), `dataCollection` off for users,
  headers, cookies, bodies, query parameters, variables and AI inputs/outputs, breadcrumbs and
  transactions dropped, and `beforeSend` = `scrubSentryEvent`: request reduced to method, path
  (no query) and `content-type`/`content-length`/`accept`; user reduced to its id; extras,
  breadcrumbs, unknown contexts, local variables and source lines removed; exception messages
  scrubbed of email addresses, links, bearer/basic credentials, `key=value` secrets, webhook secrets,
  API keys and long digit runs. Tags are bounded (`jarvis.request_id`, `jarvis.route`,
  `jarvis.job_id`, `jarvis.job_kind`, `trace_id`, `service`).
- **Logs**: `*.secret` joins the pino redaction paths (webhook secrets are shown to the user once and
  must never be logged); with tracing on, every log line carries `trace_id` and `span_id`.

Tests: `apps/api/test/unit/observability/` (redaction, tracing with an in-memory processor, Sentry
with a capturing transport, `/metrics` token and labels, the "nothing loaded when off" check).

## Turning it on

```bash
# Tracing (any OTLP/HTTP collector: OpenTelemetry Collector, Tempo, Honeycomb, …)
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.internal:4318
OTEL_SERVICE_NAME=jarvis-api            # default: jarvis-api / jarvis-worker
# Standard SDK variables still apply, e.g. sampling and collector auth:
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20…

# Errors
SENTRY_DSN=https://<key>@o<org>.ingest.sentry.io/<project>
SENTRY_ENVIRONMENT=production           # default: NODE_ENV

# Metrics
METRICS_TOKEN=<random, ≥ 24 characters; from the secret manager>
```

Only traces are set up: the SDK's own metric and log exporters (which it would otherwise enable from
`OTEL_*` defaults) are switched off, and resource detection is limited to `service.name`,
`service.version` (`APP_VERSION`), `service.instance.id` (`host:pid`) and
`deployment.environment.name` (no command line, no host details). No auto-instrumentation is
installed: HTTP auto-instrumentation would record full URLs (query strings carry search text) of
incoming requests and of outgoing ones (fetched pages, webhook endpoints). Request spans come from
Fastify hooks instead and continue an incoming W3C `traceparent`.

A part that fails to start (bad endpoint URL, SDK load error) is reported on stderr
(`telemetry: <part> failed to start`) and stays off; the process keeps serving.

Process wiring: `server.ts` calls `initTelemetry(config, 'api')` first and awaits `ready` before
building the app, and `telemetry.shutdown()` last on SIGTERM (flushes spans and error reports);
`worker.ts` does the same with `'worker'` (see "Worker metrics" for its `/metrics`).

## Spans

| Span (kind)                          | Created by                       | Attributes (all bounded)                                                                                                                                                                                                   |
| ------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<METHOD> <route template>` (SERVER) | `registerHttpInstrumentation`    | `http.request.method`, `http.route`, `jarvis.route`, `jarvis.request_id`, `http.response.status_code`                                                                                                                      |
| `job`                                | worker `processJob`              | `jarvis.job.kind`, `jarvis.job.id`, `jarvis.job.attempt`                                                                                                                                                                   |
| `tool.execute`                       | executor                         | `jarvis.tool_id`, `jarvis.tool.version`, `jarvis.tool.side_effect`, `jarvis.step.attempt`                                                                                                                                  |
| `model.call` (CLIENT)                | Anthropic adapter                | `gen_ai.system`, `gen_ai.request.model`, `jarvis.model.purpose`, `jarvis.model.effort`; after the call `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reason` |
| `webhook.deliver` (CLIENT)           | webhook delivery job             | `jarvis.webhook.event_type`, `jarvis.webhook.attempt`                                                                                                                                                                      |
| `storage.op` (CLIENT)                | document.analyze, deletion drain | `jarvis.storage.op`, `jarvis.storage.driver`                                                                                                                                                                               |
| `document.extract`                   | document.analyze                 | `jarvis.document.media_type`, `jarvis.document.bytes`                                                                                                                                                                      |
| `scheduler.tick`, `retention.sweep`  | worker timers / retention job    | `jarvis.scheduler.limit`; `jarvis.job.id`                                                                                                                                                                                  |

`withSpan(name, attributes, fn)` runs `fn` in a child span of the active one;
`addSpanAttributes()` adds attributes learnt after the fact (token counts); `currentTraceIds()`
gives the ids for log lines. 5xx responses mark the server span ERROR.

## Metrics

`GET /metrics` on the API: **404** when `METRICS_TOKEN` is unset (the route does not exist), **401**
without `Authorization: Bearer <METRICS_TOKEN>` (compared in constant time over SHA-256 digests),
otherwise the Prometheus text format, `cache-control: no-store`. It is outside the v1 route table
and OpenAPI, subject to the global rate limit (300/min per IP), and labelled `service="api"` or
`"worker"`.

| Metric                                   | Type      | Labels                                                                      |
| ---------------------------------------- | --------- | --------------------------------------------------------------------------- |
| `jarvis_http_request_duration_seconds`   | histogram | `route`, `method`, `status`                                                 |
| `jarvis_job_duration_seconds`            | histogram | `kind`, `outcome` (succeeded, retry, dead, lease_lost)                      |
| `jarvis_tool_execution_duration_seconds` | histogram | `tool`, `status`                                                            |
| `jarvis_tool_executions_total`           | counter   | `tool`, `status` (succeeded, failed, unknown)                               |
| `jarvis_model_calls_total`               | counter   | `model`, `purpose`                                                          |
| `jarvis_model_tokens_total`              | counter   | `model`, `purpose`, `direction` (input, output)                             |
| `jarvis_model_cost_usd_total`            | counter   | `model`, `purpose` (list prices, as metered)                                |
| `jarvis_sse_streams`                     | gauge     | —                                                                           |
| `jarvis_webhook_deliveries_total`        | counter   | `result` (succeeded, retry, failed)                                         |
| `jarvis_queue_jobs`                      | gauge     | `state` (ready, scheduled, running) — read from the database on each scrape |
| `jarvis_queue_oldest_ready_seconds`      | gauge     | — (read on scrape)                                                          |
| `jarvis_metrics_scrape_errors_total`     | counter   | — (queue gauges could not be read)                                          |
| `jarvis_build_info`                      | gauge     | `version`                                                                   |
| `process_*`, `nodejs_*`                  | default   | prom-client process metrics (CPU, memory, event-loop lag, GC)               |

Scrape config:

```yaml
scrape_configs:
  - job_name: jarvis-api
    scheme: https
    authorization: { type: Bearer, credentials_file: /etc/prometheus/jarvis-metrics-token }
    static_configs: [{ targets: ['api.internal:4000'] }]
```

### Worker metrics

Job, tool and model metrics are recorded where the work happens — the worker — which has no HTTP
server. `initTelemetry(config, 'worker', { metricsPort, metricsHost, db })` starts a minimal
listener that serves only `GET /metrics` with the same token check (default interface
`127.0.0.1`; pass the container interface explicitly). The API already reports the queue gauges, so
the worker passes no `db`. Until a `WORKER_METRICS_PORT` setting exists in `config.ts` (requested),
the worker is wired without a port and its job/tool/model series are not exposed; HTTP, SSE and
queue metrics come from the API.

## Alerts (suggested starting points)

| Alert                        | Expression (PromQL)                                                                                                                            | For |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| API 5xx rate                 | `sum(rate(jarvis_http_request_duration_seconds_count{status=~"5.."}[5m])) / sum(rate(jarvis_http_request_duration_seconds_count[5m])) > 0.02`  | 10m |
| API latency p95              | `histogram_quantile(0.95, sum by (le) (rate(jarvis_http_request_duration_seconds_bucket{route!="streamEvents"}[5m]))) > 1`                     | 15m |
| Queue backlog                | `jarvis_queue_oldest_ready_seconds > 120`                                                                                                      | 5m  |
| Dead jobs                    | `increase(jarvis_job_duration_seconds_count{outcome="dead"}[15m]) > 0`                                                                         | 0m  |
| Lost leases                  | `increase(jarvis_job_duration_seconds_count{outcome="lease_lost"}[15m]) > 3`                                                                   | 0m  |
| Tool failures                | `sum by (tool) (rate(jarvis_tool_executions_total{status!="succeeded"}[15m])) / sum by (tool) (rate(jarvis_tool_executions_total[15m])) > 0.2` | 15m |
| Unknown side-effect outcomes | `increase(jarvis_tool_executions_total{status="unknown"}[1h]) > 0`                                                                             | 0m  |
| Model spend                  | `sum(increase(jarvis_model_cost_usd_total[1h])) > 5`                                                                                           | 0m  |
| Webhook delivery failures    | `sum(rate(jarvis_webhook_deliveries_total{result="failed"}[30m])) > 0`                                                                         | 30m |
| Metrics scrape degraded      | `increase(jarvis_metrics_scrape_errors_total[10m]) > 0`                                                                                        | 10m |

Pair each with the operations runbook: dead jobs and stuck tasks →
[Worker stuck or dead jobs](operations.md#worker-stuck-or-dead-jobs); incidents →
[Incident response](operations.md#incident-response).

## Correlating a request

1. The client shows `requestId` (every error body has it; clients may also send `X-Request-ID`,
   8–64 `[A-Za-z0-9_-]`).
2. Logs: every request log line has `reqId`; with tracing on also `trace_id` / `span_id`.
3. Traces: search the span attribute `jarvis.request_id`, or the `trace_id` from the log line.
4. Sentry: the event's `jarvis.request_id` / `trace_id` tags.

## Overhead

`pnpm --filter @jarvis/api exec tsx evals/bench/telemetry-overhead.ts` (app.inject against the real
`buildApp`, interleaved rounds, median). Measured on the development VM (4 vCPU) while building
Phase B:

| Variant                   | µs / request | vs off |
| ------------------------- | -----------: | -----: |
| telemetry off (default)   |         52.3 |      — |
| metrics on                |         57.5 |  +9.9% |
| tracing on (no-op export) |         70.6 | +35.1% |

With telemetry off, `registerHttpInstrumentation` installs no hook and `registerMetricsRoute` no
route (unit-tested), so the request path is the same code as without observability; call sites cost
a null check (`withSpan` off ≈ a direct `await fn()`; a `metrics.*` call ≈ 3 ns). The enabled
overhead is per request in-process work (span creation, histogram observe), independent of the
handler; batch export happens off the request path.

## Troubleshooting

| Symptom                                   | Check                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No traces                                 | stderr `telemetry: tracing failed to start`; the collector accepts OTLP/HTTP JSON on `/v1/traces`; `OTEL_SDK_DISABLED` is not `true`; sampler settings |
| `/metrics` 404                            | `METRICS_TOKEN` unset (or shorter than 24 characters: the process refuses to start)                                                                    |
| `/metrics` 401                            | header must be exactly `Authorization: Bearer <token>`                                                                                                 |
| Queue gauges missing / scrape errors      | database reachable from the API; `jarvis_metrics_scrape_errors_total`                                                                                  |
| Sentry events without request URL details | by design: path only, no query, no headers beyond content type                                                                                         |
| A span attribute shows `[redacted]`       | a call site passed a value that looks like content: fix the call site, do not loosen the sanitiser                                                     |
