// Run: node --test .github/scripts/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluate, validateAllowlist } from './audit-gate.mjs';

const TODAY = '2026-11-03';

function advisory(overrides = {}) {
  return {
    id: 1100001,
    github_advisory_id: 'GHSA-abcd-2345-wxyz',
    cves: ['CVE-2026-12345'],
    module_name: 'example-lib',
    severity: 'high',
    title: 'Prototype pollution in example-lib',
    url: 'https://github.com/advisories/GHSA-abcd-2345-wxyz',
    vulnerable_versions: '<1.2.3',
    patched_versions: '>=1.2.3',
    findings: [{ version: '1.2.0', paths: ['apps__api>example-lib'] }],
    ...overrides,
  };
}
const report = (...advs) => ({
  actions: [],
  advisories: Object.fromEntries(advs.map((a) => [String(a.id), a])),
  muted: [],
  metadata: {},
});
const entry = (overrides = {}) => ({
  id: 'GHSA-abcd-2345-wxyz',
  package: 'example-lib',
  reason: 'Only reachable through the CLI import path, which JARVIS never calls.',
  expires: '2026-12-01',
  ...overrides,
});

describe('evaluate', () => {
  it('passes a clean report', () => {
    const r = evaluate(report(), { ignore: [] }, { today: TODAY });
    assert.deepEqual(r.blocking, []);
    assert.deepEqual(r.errors, []);
  });

  it('blocks high and critical advisories, most severe first', () => {
    const r = evaluate(
      report(advisory(), advisory({ id: 2, severity: 'critical', module_name: 'other' })),
      { ignore: [] },
      { today: TODAY },
    );
    assert.deepEqual(
      r.blocking.map((b) => [b.severity, b.package]),
      [
        ['critical', 'other'],
        ['high', 'example-lib'],
      ],
    );
    assert.deepEqual(r.blocking[1].paths, ['apps__api>example-lib']);
  });

  it('ignores advisories below the level', () => {
    const r = evaluate(
      report(advisory({ severity: 'moderate' })),
      { ignore: [] },
      { today: TODAY },
    );
    assert.equal(r.blocking.length, 0);
    const strict = evaluate(
      report(advisory({ severity: 'moderate' })),
      { ignore: [] },
      { today: TODAY, level: 'moderate' },
    );
    assert.equal(strict.blocking.length, 1);
  });

  it('treats unknown severities as blocking', () => {
    const r = evaluate(report(advisory({ severity: 'severe' })), { ignore: [] }, { today: TODAY });
    assert.equal(r.blocking.length, 1);
  });

  it('honours a valid allowlist entry by GHSA or CVE id', () => {
    for (const id of ['GHSA-abcd-2345-wxyz', 'CVE-2026-12345']) {
      const r = evaluate(report(advisory()), { ignore: [entry({ id })] }, { today: TODAY });
      assert.equal(r.blocking.length, 0, id);
      assert.equal(r.ignored.length, 1, id);
      assert.deepEqual(r.errors, []);
    }
  });

  it('does not apply an entry to a different package', () => {
    const r = evaluate(
      report(advisory()),
      { ignore: [entry({ package: 'unrelated' })] },
      { today: TODAY },
    );
    assert.equal(r.blocking.length, 1);
    assert.equal(r.unusedIgnores.length, 1);
  });

  it('rejects expired, too-long and unjustified entries and keeps blocking', () => {
    const r = evaluate(
      report(advisory()),
      {
        ignore: [
          entry({ expires: '2026-11-02' }),
          entry({ expires: '2027-06-01' }),
          entry({ reason: 'n/a' }),
          entry({ id: 'not-an-id' }),
          entry({ expires: 'soon' }),
        ],
      },
      { today: TODAY },
    );
    assert.equal(r.errors.length, 5);
    assert.match(r.errors[0], /expired on 2026-11-02/);
    assert.match(r.errors[1], /at most 90 days/);
    assert.match(r.errors[2], /reason/);
    assert.match(r.errors[3], /GHSA/);
    assert.match(r.errors[4], /YYYY-MM-DD/);
    assert.equal(r.blocking.length, 1);
  });

  it('fails closed on an unreadable report', () => {
    assert.throws(() => evaluate(null, { ignore: [] }), /did not return a report/);
    assert.throws(
      () => evaluate({ error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' } }, { ignore: [] }),
      /ERR_PNPM_AUDIT_BAD_RESPONSE/,
    );
    assert.throws(() => evaluate({ metadata: {} }, { ignore: [] }), /no "advisories"/);
  });

  it('requires an ignore array', () => {
    assert.deepEqual(validateAllowlist({}, TODAY).errors, [
      'allowlist must have an "ignore" array',
    ]);
  });
});

describe('CLI', () => {
  const script = fileURLToPath(new URL('./audit-gate.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'audit-gate-'));
  const run = (rep, allow) => {
    writeFileSync(join(dir, 'report.json'), JSON.stringify(rep));
    writeFileSync(join(dir, 'allow.json'), JSON.stringify(allow));
    return spawnSync(
      process.execPath,
      [script, '--input', join(dir, 'report.json'), '--allowlist', join(dir, 'allow.json')],
      { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } },
    );
  };

  it('exits 0 for a clean report', () => {
    const res = run(report(), { ignore: [] });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Dependency audit passed/);
  });

  it('exits 1 and names the advisory when blocking', () => {
    const res = run(report(advisory()), { ignore: [] });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /BLOCKING\s+high\s+example-lib GHSA-abcd-2345-wxyz/);
  });

  it('exits 1 on a non-report input', () => {
    const res = run({ error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' } }, { ignore: [] });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Dependency audit FAILED/);
  });
});
