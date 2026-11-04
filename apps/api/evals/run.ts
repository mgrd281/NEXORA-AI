/**
 * JARVIS agent evaluation runner (docs/evals.md).
 *
 *   pnpm --filter @jarvis/api eval [--mode offline|model|pipeline|all] [--suite s[,s]]
 *        [--filter text] [--out dir] [--baseline file|none] [--update-baseline]
 *        [--max-cost-usd n] [--list]
 *
 * Offline (default): deterministic rules planner + policy engine, no database.
 * Model: the Anthropic adapter when ANTHROPIC_API_KEY is set (stops at the
 * spend cap), otherwise the scenarios' scripted model output.
 * Pipeline: the full worker pipeline on the eval database
 * (EVAL_DATABASE_URL / EVAL_DATABASE_OWNER_URL, default jarvis_test_evals),
 * which is reset first.
 *
 * Writes <out>/eval-<modes>-<timestamp>.{json,md} and <out>/latest.{json,md};
 * exits 1 on any failed scenario or a regression against the baseline.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildReport,
  mergeBaseline,
  readBaseline,
  regressions,
  toBaseline,
  writeBaseline,
  writeReport,
} from './src/report';
import type { RunResult } from './src/result';
import { EVALS_DIR, loadScenarios, Mode, MODES, Suite, type LoadedScenario } from './src/scenario';
import { runModel, type ModelBudget } from './src/runners/model';
import { runOffline } from './src/runners/offline';

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'offline' },
    suite: { type: 'string' },
    filter: { type: 'string' },
    out: { type: 'string', default: path.join(EVALS_DIR, 'reports') },
    baseline: { type: 'string' },
    'update-baseline': { type: 'boolean', default: false },
    'max-cost-usd': { type: 'string', default: '2' },
    list: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const modes: Mode[] =
  values.mode === 'all'
    ? [...MODES]
    : values
        .mode!.split(',')
        .map((m) => Mode.safeParse(m.trim()).data ?? fail(`unknown mode: ${m}`));
const suites = values.suite
  ? values.suite
      .split(',')
      .map((s) => Suite.safeParse(s.trim()).data ?? fail(`unknown suite: ${s}`))
  : null;
const capUsd = Number(values['max-cost-usd']);
if (!Number.isFinite(capUsd) || capUsd < 0) fail('--max-cost-usd must be a number ≥ 0');

function commit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.env.GITHUB_SHA ?? null;
  }
}

function selected(all: LoadedScenario[], mode: Mode): LoadedScenario[] {
  return all.filter(
    (s) =>
      s.modes.includes(mode) &&
      (!suites || suites.includes(s.suite)) &&
      (!values.filter || s.id.includes(values.filter)),
  );
}

function line(r: RunResult): string {
  const mark = r.status === 'passed' ? 'PASS' : r.status === 'failed' ? 'FAIL' : 'PEND';
  const extra =
    r.status === 'pending' ? ` — ${r.reason}` : r.status === 'failed' ? ` — ${r.failures[0]}` : '';
  return `${mark} ${r.mode.padEnd(8)} ${r.suite.padEnd(11)} ${r.id}${extra}`;
}

async function main(): Promise<number> {
  const all = await loadScenarios();
  if (values.list) {
    for (const s of all)
      console.log(`${s.suite.padEnd(11)} ${s.id.padEnd(48)} ${s.modes.join(',')}`);
    console.log(`${all.length} scenarios`);
    return 0;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  const budget: ModelBudget = { capMicro: Math.round(capUsd * 1_000_000), spentMicro: 0 };
  const results: RunResult[] = [];
  const byId = new Map(all.map((s) => [s.id, s]));
  const record = (raw: RunResult) => {
    const known = byId.get(raw.id)?.knownIssue;
    // A documented gap that still fails is pending (listed with its failures), not a CI failure.
    const r: RunResult =
      known && raw.status === 'failed'
        ? { ...raw, status: 'pending', reason: `known issue: ${known}` }
        : raw;
    results.push(r);
    if (values.verbose || r.status !== 'passed') console.log(line(r));
    if (values.verbose && r.status === 'failed')
      for (const f of r.failures.slice(1)) console.log(`       ${f}`);
  };

  for (const mode of modes) {
    const scenarios = selected(all, mode);
    if (mode === 'offline') for (const s of scenarios) record(await runOffline(s));
    if (mode === 'model') for (const s of scenarios) record(await runModel(s, { apiKey, budget }));
    if (mode === 'pipeline' && scenarios.length > 0) {
      const { startPipeline, runPipeline } = await import('./src/runners/pipeline');
      const env = await startPipeline(scenarios);
      try {
        for (const s of scenarios) record(await runPipeline(env, s));
      } finally {
        await env.close();
      }
    }
  }

  const usedScript = results.some((r) => r.observed?.planner === 'scripted');
  const usedModel = results.some((r) => r.observed?.planner === 'anthropic');
  const report = buildReport(results, {
    modes,
    model: usedModel ? 'anthropic' : usedScript ? 'scripted' : 'none',
    commit: commit(),
  });
  const stamp = report.generatedAt.replace(/[-:]/g, '').replace(/\..*$/, '');
  const written = await writeReport(values.out!, `eval-${modes.join('+')}-${stamp}`, report);
  await writeReport(values.out!, 'latest', report);

  for (const [mode, s] of Object.entries(report.byMode))
    console.log(
      `${mode}: ${s.passed} passed, ${s.failed} failed, ${s.pending} pending of ${s.total}` +
        ` (pass rate ${s.passRate === null ? '—' : `${(s.passRate * 100).toFixed(1)}%`}, cost $${(s.costMicro / 1e6).toFixed(4)}, p50 ${s.latencyMs.p50 ?? '—'} ms, p95 ${s.latencyMs.p95 ?? '—'} ms)`,
    );
  console.log(`report: ${written.json}\n        ${written.md}`);

  const baselineFile =
    values.baseline === 'none'
      ? null
      : (values.baseline ?? path.join(EVALS_DIR, 'reports', 'baseline.json'));
  let exit = report.totals.failed > 0 ? 1 : 0;
  if (baselineFile) {
    const baseline = await readBaseline(baselineFile);
    if (values['update-baseline']) {
      if (suites || values.filter)
        fail('--update-baseline needs the full scenario set (no --suite / --filter)');
      const merged = mergeBaseline(baseline, toBaseline(report), modes);
      await writeBaseline(path.dirname(baselineFile), merged, report);
      console.log(`baseline updated: ${baselineFile}`);
    } else if (baseline) {
      const regressed = regressions(report, baseline);
      for (const r of regressed) console.log(`REGRESSION ${r}`);
      if (regressed.length) exit = 1;
    } else {
      console.log(`no baseline at ${baselineFile}`);
    }
  }
  return exit;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(2);
  },
);
