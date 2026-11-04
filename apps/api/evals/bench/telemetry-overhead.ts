/**
 * Telemetry overhead benchmark (docs/runbooks/observability.md):
 *
 *   pnpm --filter @jarvis/api exec tsx evals/bench/telemetry-overhead.ts [--requests 4000]
 *
 * 1. app.inject throughput of the real buildApp (test routes, no database)
 *    with telemetry off (the default), metrics on and tracing on (spans to a
 *    no-op processor), interleaved rounds, median per variant;
 * 2. the cost of an instrumented call site with telemetry off (withSpan and
 *    a metrics.* call) against the bare call.
 *
 * With telemetry off, registerHttpInstrumentation installs no hook at all
 * (unit-tested), so the request path is the same code as without it; the
 * numbers make that visible next to the cost of the enabled variants.
 */
import type { FastifyInstance } from 'fastify';
import { parseArgs } from 'node:util';
import { metrics, withSpan } from '../../src/observability';
import { startMetrics, stopMetrics } from '../../src/observability/metrics';
import { startTracing, stopTracing } from '../../src/observability/tracing';
import { fakeDb, METRICS_TOKEN, obsConfig, testApp } from '../../test/unit/observability/support';

const { values } = parseArgs({
  options: {
    requests: { type: 'string', default: '4000' },
    rounds: { type: 'string', default: '5' },
  },
});
const REQUESTS = Number(values.requests);
const ROUNDS = Number(values.rounds);

async function perRequestMicros(app: FastifyInstance, n: number): Promise<number> {
  const start = process.hrtime.bigint();
  for (let i = 0; i < n; i++) await app.inject({ url: '/v1/things/1' });
  return Number(process.hrtime.bigint() - start) / 1_000 / n;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function main(): Promise<void> {
  const { db } = fakeDb();
  const off = await testApp(obsConfig(), { db });
  await startMetrics('api');
  const withMetrics = await testApp(obsConfig({ METRICS_TOKEN }), { db });
  await startTracing(obsConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' }), 'api', {
    spanProcessors: [
      { onStart() {}, onEnd() {}, forceFlush: async () => {}, shutdown: async () => {} },
    ],
  });
  const withTracing = await testApp(
    obsConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' }),
    { db },
  );

  const variants: [string, FastifyInstance][] = [
    ['telemetry off (default)', off],
    ['metrics on', withMetrics],
    ['tracing on (no-op export)', withTracing],
  ];
  // Warm up every variant, then interleave rounds so drift hits all of them alike.
  for (const [, app] of variants) await perRequestMicros(app, 500);
  const results = new Map<string, number[]>(variants.map(([name]) => [name, []]));
  for (let r = 0; r < ROUNDS; r++)
    for (const [name, app] of variants)
      results.get(name)!.push(await perRequestMicros(app, REQUESTS));

  const base = median(results.get('telemetry off (default)')!);
  console.log(`app.inject, ${ROUNDS} rounds × ${REQUESTS} requests, median µs/request:`);
  for (const [name] of variants) {
    const m = median(results.get(name)!);
    console.log(
      `  ${name.padEnd(28)} ${m.toFixed(1).padStart(7)} µs  (${((m / base - 1) * 100).toFixed(1)}% vs off)`,
    );
  }

  for (const [, app] of variants) await app.close();
  await stopTracing();
  await stopMetrics();

  // Call-site cost with telemetry off.
  const N = 2_000_000;
  const fn = async () => 1;
  let t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) await fn();
  const bare = Number(process.hrtime.bigint() - t) / N;
  t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) await withSpan('job', { 'jarvis.job.kind': 'task.plan' }, fn);
  const spanned = Number(process.hrtime.bigint() - t) / N;
  t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) metrics.toolExecution('web.fetch', 'succeeded', 1);
  const metricCall = Number(process.hrtime.bigint() - t) / N;
  console.log('call sites with telemetry off (ns per call):');
  console.log(`  await fn()                    ${bare.toFixed(1)} ns`);
  console.log(`  await withSpan(…, fn)         ${spanned.toFixed(1)} ns`);
  console.log(`  metrics.toolExecution(…)      ${metricCall.toFixed(1)} ns`);
}

await main();
