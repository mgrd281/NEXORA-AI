#!/usr/bin/env node
/**
 * Blocking dependency audit for production dependencies (CI "security" job).
 *
 * Runs `pnpm audit --prod --json` and fails when an advisory at or above the
 * given severity is present, unless it is listed in the allowlist file with a
 * reason and an expiry date. Fails closed: if the audit cannot run or its
 * output cannot be read, the gate fails. Expired or malformed allowlist
 * entries also fail, so exceptions are re-reviewed instead of rotting.
 *
 *   node .github/scripts/audit-gate.mjs [--level high] [--allowlist .github/audit-allowlist.json]
 *                                       [--input report.json]   # use a saved report (tests)
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
/** Allowlist entries may not be granted for longer than this (days from today). */
export const MAX_IGNORE_DAYS = 90;

const ID_PATTERN = /^(?:GHSA(?:-[0-9a-z]{4}){3}|CVE-\d{4}-\d{4,})$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Severity rank; unknown severities rank above critical (fail closed). */
const rankOf = (s) => (SEVERITIES.includes(s) ? SEVERITIES.indexOf(s) : SEVERITIES.length);

/** Validates allowlist entries; returns { entries, errors }. `today` is YYYY-MM-DD (UTC). */
export function validateAllowlist(allowlist, today) {
  const errors = [];
  const list = allowlist?.ignore;
  if (!Array.isArray(list))
    return { entries: [], errors: ['allowlist must have an "ignore" array'] };
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const entries = [];
  list.forEach((e, i) => {
    const where = `allowlist entry ${i + 1}${e?.id ? ` (${e.id})` : ''}`;
    const problems = [];
    if (typeof e?.id !== 'string' || !ID_PATTERN.test(e.id))
      problems.push('"id" must be a GHSA-xxxx-xxxx-xxxx or CVE-YYYY-NNNN identifier');
    if (typeof e?.package !== 'string' || !e.package.trim())
      problems.push('"package" is required (the affected npm package name)');
    if (typeof e?.reason !== 'string' || e.reason.trim().length < 20)
      problems.push(
        '"reason" must explain (in at least 20 characters) why this is not exploitable',
      );
    const expiresMs =
      typeof e?.expires === 'string' && DATE_PATTERN.test(e.expires)
        ? Date.parse(`${e.expires}T00:00:00Z`)
        : NaN;
    if (Number.isNaN(expiresMs)) problems.push('"expires" must be a date (YYYY-MM-DD)');
    else if (expiresMs < todayMs)
      problems.push(`expired on ${e.expires}; re-review it or remove it`);
    else if (expiresMs - todayMs > MAX_IGNORE_DAYS * DAY_MS)
      problems.push(`"expires" may be at most ${MAX_IGNORE_DAYS} days ahead`);
    if (problems.length) errors.push(`${where}: ${problems.join('; ')}`);
    else entries.push(e);
  });
  return { entries, errors };
}

/**
 * Evaluates a `pnpm audit --json` report against the allowlist.
 * Returns { blocking, ignored, unusedIgnores, errors }.
 */
export function evaluate(report, allowlist, { level = 'high', today } = {}) {
  if (!SEVERITIES.includes(level)) throw new Error(`Unknown severity level: ${level}`);
  if (!report || typeof report !== 'object' || report.error)
    throw new Error(
      `pnpm audit did not return a report${report?.error ? `: ${JSON.stringify(report.error)}` : ''}`,
    );
  if (!report.advisories || typeof report.advisories !== 'object')
    throw new Error('pnpm audit report has no "advisories" object');

  const day = today ?? new Date().toISOString().slice(0, 10);
  const { entries, errors } = validateAllowlist(allowlist, day);
  const threshold = SEVERITIES.indexOf(level);
  const used = new Set();
  const blocking = [];
  const ignored = [];

  for (const adv of Object.values(report.advisories)) {
    const severity = String(adv.severity ?? 'critical').toLowerCase();
    if (rankOf(severity) < threshold) continue;
    const ids = [adv.github_advisory_id, ...(Array.isArray(adv.cves) ? adv.cves : [])].filter(
      Boolean,
    );
    const match = entries.find((e) => ids.includes(e.id) && e.package === adv.module_name);
    const item = {
      severity,
      package: String(adv.module_name ?? 'unknown'),
      id: adv.github_advisory_id ?? (ids[0] || `npm-${adv.id}`),
      title: adv.title ?? '',
      url: adv.url ?? '',
      vulnerable: adv.vulnerable_versions ?? '',
      patched: adv.patched_versions ?? '',
      paths: [...new Set((adv.findings ?? []).flatMap((f) => f.paths ?? []))],
    };
    if (match) {
      used.add(match);
      ignored.push({ ...item, reason: match.reason, expires: match.expires });
    } else {
      blocking.push(item);
    }
  }
  const unusedIgnores = entries.filter((e) => !used.has(e));
  // Most severe first, then by package name, so output is stable.
  blocking.sort(
    (a, b) => rankOf(b.severity) - rankOf(a.severity) || a.package.localeCompare(b.package),
  );
  return { blocking, ignored, unusedIgnores, errors };
}

function runPnpmAudit() {
  const res = spawnSync('pnpm', ['audit', '--prod', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`could not run pnpm audit: ${res.error.message}`);
  // pnpm exits 1 when it finds vulnerabilities; the JSON report is what counts.
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(
      `pnpm audit output is not JSON (exit ${res.status}):\n${(res.stdout + res.stderr).slice(0, 2000)}`,
    );
  }
}

function format(result, level) {
  const lines = [];
  for (const b of result.blocking) {
    lines.push(`BLOCKING  ${b.severity.padEnd(8)} ${b.package} ${b.id} ${b.title}`);
    lines.push(`          vulnerable ${b.vulnerable || '?'}; patched ${b.patched || 'none'}`);
    if (b.url) lines.push(`          ${b.url}`);
    for (const p of b.paths.slice(0, 3)) lines.push(`          via ${p}`);
  }
  for (const i of result.ignored)
    lines.push(
      `ignored   ${i.severity.padEnd(8)} ${i.package} ${i.id} until ${i.expires}: ${i.reason}`,
    );
  for (const u of result.unusedIgnores)
    lines.push(`note      allowlist entry ${u.id} (${u.package}) matched nothing; remove it`);
  for (const e of result.errors) lines.push(`ERROR     ${e}`);
  const ok = result.blocking.length === 0 && result.errors.length === 0;
  lines.push(
    ok
      ? `Dependency audit passed: no unallowlisted production advisories at or above "${level}".`
      : `Dependency audit FAILED: ${result.blocking.length} blocking advisor${result.blocking.length === 1 ? 'y' : 'ies'}, ${result.errors.length} allowlist error(s). Upgrade the dependency, or add a justified, expiring entry to .github/audit-allowlist.json.`,
  );
  return { ok, text: lines.join('\n') };
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const { values } = parseArgs({
    options: {
      level: { type: 'string', default: 'high' },
      allowlist: { type: 'string', default: resolve(here, '../audit-allowlist.json') },
      input: { type: 'string' },
    },
  });
  const report = values.input ? JSON.parse(readFileSync(values.input, 'utf8')) : runPnpmAudit();
  const allowlist = JSON.parse(readFileSync(values.allowlist, 'utf8'));
  const result = evaluate(report, allowlist, { level: values.level });
  const { ok, text } = format(result, values.level);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Dependency audit (production, ≥ ${values.level})\n\n\`\`\`\n${text}\n\`\`\`\n`,
    );
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`Dependency audit FAILED: ${err.message}`);
    process.exitCode = 1;
  });
}
