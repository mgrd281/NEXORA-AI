/**
 * Eval reports: JSON (machine-readable, every result) and Markdown (for
 * people and CI summaries), plus the committed baseline and the comparison
 * that gates CI (docs/evals.md).
 *
 * Pass rate = passed / (passed + failed): pending scenarios (capability not
 * in this build, no API key, spend cap) are counted and listed separately,
 * never folded into the rate. Latency is wall time per scenario (planning +
 * policy offline; the whole worker pipeline in pipeline mode); cost is
 * metered model spend in micro-USD (0 offline).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunResult, RunStatus } from './result';
import type { Mode } from './scenario';

export const REPORT_FORMAT = 1;

export interface Summary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  /** passed / (passed + failed), or null when nothing ran. */
  passRate: number | null;
  costMicro: number;
  latencyMs: { p50: number | null; p95: number | null };
}

export interface Report {
  format: number;
  generatedAt: string;
  commit: string | null;
  modes: Mode[];
  /** Which model answered model-mode scenarios. */
  model: 'anthropic' | 'scripted' | 'none';
  totals: Summary;
  byMode: Partial<Record<Mode, Summary>>;
  /** Keyed "<mode>/<suite>". */
  bySuite: Record<string, Summary>;
  results: RunResult[];
}

/** The committed baseline: statuses only (no timings), so it changes only when results do. */
export interface Baseline {
  format: number;
  byMode: Partial<
    Record<Mode, Pick<Summary, 'total' | 'passed' | 'failed' | 'pending' | 'passRate'>>
  >;
  results: {
    id: string;
    mode: Mode;
    suite: string;
    version: number;
    status: RunStatus;
    reason?: string;
  }[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[i]! * 10) / 10;
}

export function summarize(results: readonly RunResult[]): Summary {
  const count = (s: RunStatus) => results.filter((r) => r.status === s).length;
  const passed = count('passed');
  const failed = count('failed');
  const ran = results.filter((r) => r.status !== 'pending');
  const latencies = ran.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    total: results.length,
    passed,
    failed,
    pending: count('pending'),
    passRate:
      passed + failed > 0 ? Math.round((passed / (passed + failed)) * 10_000) / 10_000 : null,
    costMicro: results.reduce((n, r) => n + r.costMicro, 0),
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
  };
}

export function buildReport(
  results: RunResult[],
  meta: { modes: Mode[]; model: Report['model']; commit: string | null },
): Report {
  const byMode: Report['byMode'] = {};
  for (const m of meta.modes) byMode[m] = summarize(results.filter((r) => r.mode === m));
  const bySuite: Record<string, Summary> = {};
  for (const key of [...new Set(results.map((r) => `${r.mode}/${r.suite}`))].sort())
    bySuite[key] = summarize(results.filter((r) => `${r.mode}/${r.suite}` === key));
  return {
    format: REPORT_FORMAT,
    generatedAt: new Date().toISOString(),
    commit: meta.commit,
    modes: meta.modes,
    model: meta.model,
    totals: summarize(results),
    byMode,
    bySuite,
    results,
  };
}

const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);
const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(4)}`;
const ms = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)} ms`);
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function toMarkdown(report: Report, opts: { timings?: boolean } = {}): string {
  const timings = opts.timings ?? true;
  const lines: string[] = [];
  lines.push('# JARVIS agent evaluations', '');
  lines.push(
    timings
      ? `Modes: ${report.modes.join(', ')} · model: ${report.model}` +
          (report.commit ? ` · commit \`${report.commit.slice(0, 12)}\`` : '') +
          ` · ${report.generatedAt}`
      : `Committed baseline (statuses only) · modes: ${report.modes.join(', ')} · model mode as run without ANTHROPIC_API_KEY (scripted model output)`,
    '',
  );
  lines.push('## Summary', '');
  lines.push(
    timings
      ? '| Mode | Scenarios | Passed | Failed | Pending | Pass rate | Cost | Latency p50 | Latency p95 |'
      : '| Mode | Scenarios | Passed | Failed | Pending | Pass rate |',
  );
  lines.push(
    timings ? '|---|---:|---:|---:|---:|---:|---:|---:|---:|' : '|---|---:|---:|---:|---:|---:|',
  );
  for (const [mode, s] of Object.entries(report.byMode)) {
    const base = `| ${mode} | ${s.total} | ${s.passed} | ${s.failed} | ${s.pending} | ${pct(s.passRate)} |`;
    lines.push(
      timings
        ? `${base} ${usd(s.costMicro)} | ${ms(s.latencyMs.p50)} | ${ms(s.latencyMs.p95)} |`
        : base,
    );
  }
  lines.push('', '## By suite', '');
  lines.push('| Mode / suite | Scenarios | Passed | Failed | Pending | Pass rate |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const [key, s] of Object.entries(report.bySuite))
    lines.push(
      `| ${key} | ${s.total} | ${s.passed} | ${s.failed} | ${s.pending} | ${pct(s.passRate)} |`,
    );

  const failed = report.results.filter((r) => r.status === 'failed');
  lines.push('', `## Failures (${failed.length})`, '');
  if (failed.length === 0) lines.push('None.');
  for (const r of failed) {
    lines.push(`- **${r.id}** (${r.mode}, ${r.file}): ${cell(r.title)}`);
    for (const f of r.failures) lines.push(`  - ${cell(f)}`);
  }
  const pend = report.results.filter((r) => r.status === 'pending');
  lines.push('', `## Pending (${pend.length})`, '');
  if (pend.length === 0) lines.push('None.');
  for (const r of pend) lines.push(`- **${r.id}** (${r.mode}): ${cell(r.reason ?? '')}`);

  lines.push('', '## All scenarios', '');
  lines.push(
    timings
      ? '| Scenario | Suite | Mode | Status | Latency |'
      : '| Scenario | Suite | Mode | Status |',
  );
  lines.push(timings ? '|---|---|---|---|---:|' : '|---|---|---|---|');
  for (const r of report.results)
    lines.push(
      `| ${r.id} v${r.version} | ${r.suite} | ${r.mode} | ${r.status} |` +
        (timings
          ? ` ${r.status === 'pending' ? '—' : ms(Math.round(r.latencyMs * 10) / 10)} |`
          : ''),
    );
  return `${lines.join('\n')}\n`;
}

export function toBaseline(report: Report): Baseline {
  const byMode: Baseline['byMode'] = {};
  for (const [mode, s] of Object.entries(report.byMode))
    byMode[mode as Mode] = {
      total: s.total,
      passed: s.passed,
      failed: s.failed,
      pending: s.pending,
      passRate: s.passRate,
    };
  return {
    format: REPORT_FORMAT,
    byMode,
    results: report.results.map((r) => ({
      id: r.id,
      mode: r.mode,
      suite: r.suite,
      version: r.version,
      status: r.status,
      ...(r.reason ? { reason: r.reason } : {}),
    })),
  };
}

/** Keeps the baseline entries of modes not in this run (a run of one mode updates only that mode). */
export function mergeBaseline(
  previous: Baseline | null,
  next: Baseline,
  modes: readonly Mode[],
): Baseline {
  if (!previous) return next;
  const keep = previous.results.filter((r) => !modes.includes(r.mode));
  const byMode = { ...previous.byMode, ...next.byMode };
  const results = [...keep, ...next.results].sort(
    (a, b) =>
      a.mode.localeCompare(b.mode) || a.suite.localeCompare(b.suite) || a.id.localeCompare(b.id),
  );
  return { format: REPORT_FORMAT, byMode, results };
}

/**
 * What makes CI fail besides a failed scenario: a scenario that passed in the
 * baseline and does not pass now (failed or newly pending), or a lower pass
 * rate for a mode that ran.
 */
export function regressions(report: Report, baseline: Baseline): string[] {
  const out: string[] = [];
  const now = new Map(report.results.map((r) => [`${r.mode}:${r.id}`, r]));
  for (const b of baseline.results) {
    if (!report.modes.includes(b.mode) || b.status !== 'passed') continue;
    const r = now.get(`${b.mode}:${b.id}`);
    if (!r) continue; // removed or filtered out of this run
    if (r.status !== 'passed')
      out.push(`${b.id} (${b.mode}) passed in the baseline and is ${r.status} now`);
  }
  for (const mode of report.modes) {
    const was = baseline.byMode[mode]?.passRate;
    const is = report.byMode[mode]?.passRate;
    if (typeof was === 'number' && typeof is === 'number' && is < was)
      out.push(`${mode} pass rate dropped from ${pct(was)} to ${pct(is)}`);
  }
  return out;
}

export async function readBaseline(file: string): Promise<Baseline | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Baseline;
  } catch {
    return null;
  }
}

export async function writeReport(
  dir: string,
  name: string,
  report: Report,
): Promise<{ json: string; md: string }> {
  await mkdir(dir, { recursive: true });
  const json = path.join(dir, `${name}.json`);
  const md = path.join(dir, `${name}.md`);
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(md, toMarkdown(report));
  return { json, md };
}

/** Formats a committed file with the repository's Prettier config (when Prettier is installed). */
async function formatted(file: string, text: string): Promise<string> {
  try {
    const prettier = await import('prettier');
    const options = (await prettier.resolveConfig(file)) ?? {};
    return await prettier.format(text, { ...options, filepath: file });
  } catch {
    return text;
  }
}

export async function writeBaseline(
  dir: string,
  baseline: Baseline,
  report: Report,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const jsonFile = path.join(dir, 'baseline.json');
  await writeFile(jsonFile, await formatted(jsonFile, `${JSON.stringify(baseline, null, 2)}\n`));
  // The Markdown baseline mirrors the merged baseline's statuses (no timings, so it is stable).
  const merged: Report = {
    ...report,
    modes: Object.keys(baseline.byMode) as Mode[],
    commit: null,
    byMode: Object.fromEntries(
      Object.entries(baseline.byMode).map(([m, s]) => [
        m,
        { ...s, costMicro: 0, latencyMs: { p50: null, p95: null } },
      ]),
    ),
    bySuite: {},
    results: baseline.results.map((r) => ({
      ...r,
      suite: r.suite as RunResult['suite'],
      title: '',
      file: '',
      failures: [],
      latencyMs: 0,
      costMicro: 0,
    })),
  };
  for (const key of [...new Set(merged.results.map((r) => `${r.mode}/${r.suite}`))].sort())
    merged.bySuite[key] = summarize(merged.results.filter((r) => `${r.mode}/${r.suite}` === key));
  const mdFile = path.join(dir, 'baseline.md');
  await writeFile(mdFile, await formatted(mdFile, toMarkdown(merged, { timings: false })));
}
