/**
 * Prometheus metrics (prom-client), on only when METRICS_TOKEN is set.
 *
 * `metrics.*` is a facade every call site uses unconditionally: until the
 * registry is started (initTelemetry with METRICS_TOKEN) each method is a
 * single null check, and prom-client is never loaded.
 *
 * Exposition: GET /metrics on the API (registerMetricsRoute) and, when the
 * worker is given a port, on a small listener of its own (serveMetrics),
 * both behind `Authorization: Bearer <METRICS_TOKEN>` (compared in constant
 * time). The endpoints are outside the v1 route table and OpenAPI.
 *
 * Labels are bounded: route names (contract route names or templates, never
 * raw paths), HTTP methods and status codes, job kinds and outcomes, tool ids
 * and statuses, model ids and purposes. Every label value passes labelValue
 * (redact.ts); anything else becomes 'other'.
 */
import type { ToolId } from '@jarvis/contracts';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../config';
import type { Db } from '../db/pool';
import type { JobKind } from '../db/types';
import { labelValue } from './redact';
import type { TelemetryService } from './tracing';

export type JobOutcomeLabel = 'succeeded' | 'retry' | 'dead' | 'lease_lost';
export type ToolStatusLabel = 'succeeded' | 'failed' | 'unknown';
export type WebhookResultLabel = 'succeeded' | 'retry' | 'failed';

export interface ModelUsageSample {
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  costMicro: number;
}

type PromClient = typeof import('prom-client');
type Registry = InstanceType<PromClient['Registry']>;

interface Impl {
  registry: Registry;
  httpRequest(route: string, method: string, status: number, durationMs: number): void;
  jobFinished(kind: string, outcome: string, durationMs: number): void;
  toolExecution(toolId: string, status: string, durationMs: number): void;
  modelUsage(u: ModelUsageSample): void;
  sseStreams(delta: number): void;
  webhookDelivery(result: string): void;
  /** Reads the queue gauges from the database (on scrape). */
  collectQueue(db: Db): Promise<void>;
}

let impl: Impl | null = null;
let starting: Promise<Impl> | null = null;
let startedFor: TelemetryService = 'api';

const seconds = (ms: number) => (Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0);
const count = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/** The facade: every method is a no-op until metrics are started. */
export const metrics = {
  /** One finished HTTP request; `route` is the contract route name or template. */
  httpRequest(route: string, method: string, status: number, durationMs: number): void {
    impl?.httpRequest(route, method, status, durationMs);
  },
  /** One job run by the worker, with how it ended. */
  jobFinished(kind: JobKind, outcome: JobOutcomeLabel, durationMs: number): void {
    impl?.jobFinished(kind, outcome, durationMs);
  },
  /** One tool execution (side effect attempted or read performed). */
  toolExecution(toolId: ToolId, status: ToolStatusLabel, durationMs: number): void {
    impl?.toolExecution(toolId, status, durationMs);
  },
  /** Tokens and cost of one model call (counts only, never content). */
  modelUsage(u: ModelUsageSample): void {
    impl?.modelUsage(u);
  },
  /** An SSE stream opened (+1) or closed (-1). */
  sseStreams(delta: 1 | -1): void {
    impl?.sseStreams(delta);
  },
  /** One webhook delivery attempt and its result. */
  webhookDelivery(result: WebhookResultLabel): void {
    impl?.webhookDelivery(result);
  },
};

export function metricsConfigured(config: Pick<Config, 'METRICS_TOKEN'>): boolean {
  return !!config.METRICS_TOKEN;
}

/** Whether samples are being recorded right now. */
export function metricsEnabled(): boolean {
  return impl !== null;
}

async function build(service: TelemetryService, version: string): Promise<Impl> {
  const prom = await import('prom-client');
  const registry = new prom.Registry();
  registry.setDefaultLabels({ service });
  prom.collectDefaultMetrics({ register: registry });

  new prom.Gauge({
    name: 'jarvis_build_info',
    help: 'Build of this process (always 1).',
    labelNames: ['version'],
    registers: [registry],
  }).set({ version: labelValue(version) }, 1);

  const http = new prom.Histogram({
    name: 'jarvis_http_request_duration_seconds',
    help: 'HTTP request latency by contract route.',
    labelNames: ['route', 'method', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  });
  const job = new prom.Histogram({
    name: 'jarvis_job_duration_seconds',
    help: 'Worker job duration by kind and outcome.',
    labelNames: ['kind', 'outcome'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [registry],
  });
  const tool = new prom.Histogram({
    name: 'jarvis_tool_execution_duration_seconds',
    help: 'Tool execution duration by tool and status.',
    labelNames: ['tool', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });
  const toolTotal = new prom.Counter({
    name: 'jarvis_tool_executions_total',
    help: 'Tool executions by tool and status.',
    labelNames: ['tool', 'status'],
    registers: [registry],
  });
  const modelCalls = new prom.Counter({
    name: 'jarvis_model_calls_total',
    help: 'Model calls by model and purpose.',
    labelNames: ['model', 'purpose'],
    registers: [registry],
  });
  const modelTokens = new prom.Counter({
    name: 'jarvis_model_tokens_total',
    help: 'Model tokens by model, purpose and direction (input/output).',
    labelNames: ['model', 'purpose', 'direction'],
    registers: [registry],
  });
  const modelCost = new prom.Counter({
    name: 'jarvis_model_cost_usd_total',
    help: 'Model cost in USD by model and purpose (list prices, as metered).',
    labelNames: ['model', 'purpose'],
    registers: [registry],
  });
  const sse = new prom.Gauge({
    name: 'jarvis_sse_streams',
    help: 'Open server-sent event streams.',
    registers: [registry],
  });
  const webhooks = new prom.Counter({
    name: 'jarvis_webhook_deliveries_total',
    help: 'Webhook delivery attempts by result.',
    labelNames: ['result'],
    registers: [registry],
  });
  const queue = new prom.Gauge({
    name: 'jarvis_queue_jobs',
    help: 'Jobs in the queue by state (ready: due now; scheduled: due later; running: leased).',
    labelNames: ['state'],
    registers: [registry],
  });
  const oldest = new prom.Gauge({
    name: 'jarvis_queue_oldest_ready_seconds',
    help: 'How long the oldest ready job has waited.',
    registers: [registry],
  });
  const scrapeErrors = new prom.Counter({
    name: 'jarvis_metrics_scrape_errors_total',
    help: 'Scrapes whose database-backed gauges could not be read.',
    registers: [registry],
  });

  return {
    registry,
    httpRequest(route, method, status, durationMs) {
      http.observe(
        { route: labelValue(route), method: labelValue(method), status: labelValue(status) },
        seconds(durationMs),
      );
    },
    jobFinished(kind, outcome, durationMs) {
      job.observe({ kind: labelValue(kind), outcome: labelValue(outcome) }, seconds(durationMs));
    },
    toolExecution(toolId, status, durationMs) {
      const labels = { tool: labelValue(toolId), status: labelValue(status) };
      tool.observe(labels, seconds(durationMs));
      toolTotal.inc(labels);
    },
    modelUsage(u) {
      const base = { model: labelValue(u.model), purpose: labelValue(u.purpose) };
      modelCalls.inc(base);
      modelTokens.inc({ ...base, direction: 'input' }, count(u.inputTokens));
      modelTokens.inc({ ...base, direction: 'output' }, count(u.outputTokens));
      modelCost.inc(base, count(u.costMicro) / 1_000_000);
    },
    sseStreams(delta) {
      if (delta > 0) sse.inc();
      else sse.dec();
    },
    webhookDelivery(result) {
      webhooks.inc({ result: labelValue(result) });
    },
    async collectQueue(db) {
      try {
        const r = await sql<{
          ready: string;
          scheduled: string;
          running: string;
          oldest: string | null;
        }>`
          SELECT count(*) FILTER (WHERE status = 'queued' AND run_at <= now()) AS ready,
                 count(*) FILTER (WHERE status = 'queued' AND run_at > now()) AS scheduled,
                 count(*) FILTER (WHERE status = 'running') AS running,
                 extract(epoch FROM now() - min(run_at) FILTER (WHERE status = 'queued' AND run_at <= now())) AS oldest
            FROM jobs WHERE status IN ('queued', 'running')`.execute(db);
        const row = r.rows[0];
        queue.set({ state: 'ready' }, Number(row?.ready ?? 0));
        queue.set({ state: 'scheduled' }, Number(row?.scheduled ?? 0));
        queue.set({ state: 'running' }, Number(row?.running ?? 0));
        oldest.set(Math.max(0, Number(row?.oldest ?? 0)));
      } catch {
        scrapeErrors.inc();
      }
    },
  };
}

/** Loads prom-client and creates the registry (idempotent). */
export async function startMetrics(service: TelemetryService, version = 'unknown'): Promise<void> {
  if (impl) return;
  startedFor = service;
  starting ??= build(service, version);
  impl = await starting;
}

/** Drops the registry (tests; shutdown). */
export async function stopMetrics(): Promise<void> {
  impl?.registry.clear();
  impl = null;
  starting = null;
}

/** The text exposition of every metric (Prometheus format) and its content type. */
export async function renderMetrics(db: Db | null): Promise<{ contentType: string; body: string }> {
  if (!impl) await startMetrics(startedFor);
  const current = impl!;
  if (db) await current.collectQueue(db);
  return { contentType: current.registry.contentType, body: await current.registry.metrics() };
}

/**
 * Whether an Authorization header carries the metrics token. Both sides are
 * hashed first so the comparison is constant-time whatever the lengths.
 */
export function metricsAuthorized(token: string, header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  const presented = value?.startsWith('Bearer ') ? value.slice(7).trim() : '';
  if (!presented) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

const UNAUTHORIZED = {
  error: { code: 'UNAUTHENTICATED', message: 'A metrics token is required.' },
};

/**
 * GET /metrics on the API: absent (404) when METRICS_TOKEN is unset, 401
 * without the bearer token, otherwise the registry plus queue gauges read
 * from the database on each scrape.
 */
export function registerMetricsRoute(
  app: FastifyInstance,
  deps: { config: Pick<Config, 'METRICS_TOKEN' | 'APP_VERSION'>; db: Db },
): void {
  const token = deps.config.METRICS_TOKEN;
  if (!token) return;
  app.get('/metrics', async (req, reply) => {
    if (!metricsAuthorized(token, req.headers.authorization)) {
      return reply
        .code(401)
        .header('www-authenticate', 'Bearer')
        .send({ error: { ...UNAUTHORIZED.error, requestId: req.id } });
    }
    const out = await renderMetrics(deps.db);
    return reply
      .header('content-type', out.contentType)
      .header('cache-control', 'no-store')
      .send(out.body);
  });
}

/**
 * A minimal listener for a process without an HTTP server (the worker):
 * GET /metrics with the same token check, nothing else. Queue gauges are
 * read only when `db` is given (the API already reports them).
 */
export async function serveMetrics(
  deps: { config: Pick<Config, 'METRICS_TOKEN'>; db?: Db },
  opts: { port: number; host?: string },
): Promise<{ port: number; close(): Promise<void> }> {
  const token = deps.config.METRICS_TOKEN;
  if (!token) throw new Error('serveMetrics needs METRICS_TOKEN');
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' || path !== '/metrics') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
    }
    if (!metricsAuthorized(token, req.headers.authorization)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      return res.end(JSON.stringify(UNAUTHORIZED));
    }
    renderMetrics(deps.db ?? null)
      .then((out) => {
        res.writeHead(200, { 'content-type': out.contentType, 'cache-control': 'no-store' });
        res.end(out.body);
      })
      .catch(() => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'Metrics unavailable' } }));
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
