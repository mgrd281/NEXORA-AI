/**
 * The agent evaluation framework (apps/api/evals): every scenario file is
 * valid, the comparison catches what it should, offline runs are
 * deterministic, pending is never silent, and the baseline gate works.
 */
import { describe, expect, it } from 'vitest';
import { missingCapabilities } from '../../../evals/src/capabilities';
import { compare, type Observed } from '../../../evals/src/expect';
import {
  buildReport,
  mergeBaseline,
  regressions,
  summarize,
  toBaseline,
  toMarkdown,
} from '../../../evals/src/report';
import type { RunResult } from '../../../evals/src/result';
import { runModel } from '../../../evals/src/runners/model';
import { runOffline } from '../../../evals/src/runners/offline';
import {
  loadScenarios,
  Scenario,
  substitute,
  SUITES,
  type LoadedScenario,
} from '../../../evals/src/scenario';

const scenarios = await loadScenarios();
const byId = (id: string) => scenarios.find((s) => s.id === id)!;

describe('scenario files', () => {
  it('cover every suite with at least 60 offline scenarios', () => {
    const offline = scenarios.filter((s) => s.modes.includes('offline'));
    expect(offline.length).toBeGreaterThanOrEqual(60);
    for (const suite of SUITES) expect(scenarios.some((s) => s.suite === suite)).toBe(true);
  });

  it('include the ten spec scenarios', () => {
    for (let n = 1; n <= 10; n++) {
      const prefix = `spec-${String(n).padStart(2, '0')}-`;
      expect(
        scenarios.some((s) => s.id.startsWith(prefix)),
        prefix,
      ).toBe(true);
    }
  });

  it('reject malformed scenarios', () => {
    const bad = Scenario.safeParse({
      id: 'Bad Id',
      version: 0,
      suite: 'nope',
      title: 't',
      modes: [],
      given: { request: 'x' },
      expect: { result: 'maybe' },
    });
    expect(bad.success).toBe(false);
    const synthetic = Scenario.safeParse({
      ...byId('spec-06-critical-action-denied'),
      modes: ['offline', 'pipeline'],
    });
    expect(synthetic.success).toBe(false);
  });
});

describe('substitute', () => {
  it('replaces placeholders in values and keys', () => {
    const out = substitute(
      {
        a: '{{me}} {{site}}/x {{down}}',
        b: ['{{turn0}}', '{{file1}}', '{{turn9}}'],
        '{{site}}/p': 'page',
      },
      { me: 'me@x.test', site: 'https://s', down: 'http://d', turns: ['t0'], files: ['f0', 'f1'] },
    );
    expect(out).toEqual({
      a: 'me@x.test https://s/x http://d',
      b: ['t0', 'f1', '{{turn9}}'],
      'https://s/p': 'page',
    });
  });
});

const observed = (o: Partial<Observed> = {}): Observed => ({
  result: 'plan',
  toolSequence: ['web.fetch', 'text.summarize', 'email.send'],
  missing: null,
  errorReason: null,
  recipients: ['me@x.test'],
  urls: ['https://s/a'],
  policy: [
    { step: 0, toolId: 'web.fetch', decision: 'allow', reasons: ['RISK_LOW'] },
    {
      step: 2,
      toolId: 'email.send',
      decision: 'require_approval',
      reasons: ['RISK_MEDIUM', 'UNTRUSTED_CONTENT'],
    },
  ],
  flagged: true,
  sideEffects: null,
  schedule: null,
  planner: 'offline',
  costMicro: 0,
  ...o,
});

describe('compare', () => {
  const base = Scenario.parse({ ...byId('injection-summarize-email') }).expect;
  const expected = substitute(base, {
    me: 'me@x.test',
    site: 'https://s',
    down: '',
    turns: [],
    files: [],
  });
  const ok = observed({ urls: ['https://s/flights'] });

  it('passes a matching observation', () => {
    expect(compare(expected, ok, 'offline')).toEqual([]);
  });

  it('catches a changed recipient, a lost approval reason, a missing flag and a wrong sequence', () => {
    expect(compare(expected, { ...ok, recipients: ['attacker@evil.test'] }, 'offline')[0]).toMatch(
      /^recipients/,
    );
    expect(
      compare(
        expected,
        {
          ...ok,
          policy: [
            {
              step: 2,
              toolId: 'email.send',
              decision: 'require_approval',
              reasons: ['RISK_MEDIUM'],
            },
          ],
        },
        'offline',
      )[0],
    ).toMatch(/lack \["UNTRUSTED_CONTENT"\]/);
    expect(compare(expected, { ...ok, flagged: false }, 'offline')).toEqual([
      'flagged: expected true, got false',
    ]);
    expect(compare(expected, { ...ok, toolSequence: ['web.fetch'] }, 'offline')[0]).toMatch(
      /^toolSequence/,
    );
    expect(compare(expected, { ...ok, policy: [] }, 'offline')[0]).toMatch(/no policy decision/);
  });

  it('checks reasons that must be absent', () => {
    const e = {
      ...expected,
      policy: [
        {
          step: 2,
          decision: 'require_approval' as const,
          reasonsInclude: [],
          reasonsExclude: ['UNTRUSTED_CONTENT'],
        },
      ],
    };
    expect(compare(e, ok, 'offline')[0]).toMatch(/must not include/);
  });

  it('applies pipeline-only checks only in pipeline mode', () => {
    const e = {
      ...expected,
      pipeline: { status: 'AWAITING_APPROVAL' as const, sideEffectsExactly: 0 },
    };
    expect(compare(e, ok, 'offline')).toEqual([]);
    expect(compare(e, ok, 'pipeline')).toEqual(['pipeline: nothing observed']);
    const run = {
      ...ok,
      sideEffects: 1,
      pipeline: {
        status: 'COMPLETED' as const,
        outcome: 'action' as const,
        errorCode: null,
        errorReason: null,
        retryable: null,
        retryNeedsAcknowledgement: null,
        executions: {},
        schedulesCreated: 0,
        scheduledTasks: 0,
      },
    };
    expect(compare(e, run, 'pipeline')).toEqual([
      'side effects: expected at most 0, got 1',
      'status: expected AWAITING_APPROVAL, got COMPLETED',
      'side effects: expected exactly 0, got 1',
    ]);
  });
});

describe('offline runner', () => {
  const offline = scenarios.filter((s) => s.modes.includes('offline'));

  it('is deterministic: two runs observe exactly the same', async () => {
    const strip = (r: RunResult) => ({
      id: r.id,
      status: r.status,
      failures: r.failures,
      observed: r.observed,
    });
    const first = await Promise.all(offline.map((s) => runOffline(s).then(strip)));
    const second = await Promise.all(offline.map((s) => runOffline(s).then(strip)));
    expect(second).toEqual(first);
  });

  it('fails a scenario whose expectation is wrong (the runner is not vacuous)', async () => {
    const s = byId('spec-07-prompt-injection');
    const tampered: LoadedScenario = {
      ...s,
      expect: { ...s.expect, recipientsExactly: ['attacker@evil.test'], flagged: false },
    };
    const r = await runOffline(tampered);
    expect(r.status).toBe('failed');
    expect(r.failures.join('\n')).toMatch(/recipients[\s\S]*flagged/);
  });

  it('reports a missing capability as pending, with the reason', async () => {
    const r = await runOffline({
      ...byId('planning-summarize-url-en'),
      requires: ['tool:commerce.purchase'],
    });
    expect(r).toMatchObject({
      status: 'pending',
      reason: 'capability missing: tool:commerce.purchase',
    });
  });
});

describe('model runner', () => {
  it('without a key, unscripted scenarios are pending (never skipped silently)', async () => {
    const r = await runModel(byId('spec-02-compare-products'), {
      budget: { capMicro: 1, spentMicro: 0 },
    });
    expect(r).toMatchObject({
      status: 'pending',
      reason: 'needs ANTHROPIC_API_KEY (no scripted plans)',
    });
  });

  it('stops calling the real model at the spend cap', async () => {
    const r = await runModel(byId('spec-02-compare-products'), {
      apiKey: 'sk-test-not-used',
      budget: { capMicro: 100, spentMicro: 100 },
    });
    expect(r).toMatchObject({ status: 'pending', reason: 'spend cap reached' });
  });

  it('plays scripted plans through the real planner (validation + repair)', async () => {
    const r = await runModel(byId('literal-model-recipient-from-result-rejected'), {
      budget: { capMicro: 0, spentMicro: 0 },
    });
    expect(r.status).toBe('passed');
    expect(r.observed).toMatchObject({ planner: 'scripted', result: 'question', costMicro: 0 });
  });
});

describe('capabilities', () => {
  it('probes tools, module exports and pipeline-only services', async () => {
    expect(
      await missingCapabilities(['tool:web.fetch', 'tool:nope.tool'], { mode: 'offline' }),
    ).toEqual(['tool:nope.tool']);
    expect(
      await missingCapabilities(
        [
          'export:modules/agent/plan#validatePlan',
          'export:modules/agent/plan#nope',
          'export:modules/nope#x',
        ],
        { mode: 'offline' },
      ),
    ).toEqual(['export:modules/agent/plan#nope', 'export:modules/nope#x']);
    expect(await missingCapabilities(['service:followUp', 'storage'], { mode: 'offline' })).toEqual(
      [],
    );
    expect(
      await missingCapabilities(['service:followUp', 'storage'], { mode: 'pipeline' }),
    ).toEqual(['service:followUp', 'storage']);
    expect(await missingCapabilities(['weird'], { mode: 'offline' })).toEqual([
      'weird (unknown capability kind)',
    ]);
  });
});

describe('reports and the baseline gate', () => {
  const r = (id: string, status: RunResult['status'], latencyMs = 10): RunResult => ({
    id,
    version: 1,
    suite: 'planning',
    mode: 'offline',
    title: id,
    file: `planning/${id}.json`,
    status,
    failures: status === 'failed' ? ['result: expected plan, got deny'] : [],
    ...(status === 'pending' ? { reason: 'capability missing: tool:x' } : {}),
    latencyMs,
    costMicro: 0,
  });

  it('pass rate excludes pending; percentiles over runs only', () => {
    const s = summarize([
      r('a', 'passed', 1),
      r('b', 'passed', 3),
      r('c', 'failed', 5),
      r('d', 'pending', 999),
    ]);
    expect(s).toMatchObject({ total: 4, passed: 2, failed: 1, pending: 1, passRate: 0.6667 });
    expect(s.latencyMs).toEqual({ p50: 3, p95: 5 });
  });

  it('flags a baseline pass that is no longer passing, and a lower pass rate', () => {
    const before = buildReport([r('a', 'passed'), r('b', 'passed')], {
      modes: ['offline'],
      model: 'none',
      commit: null,
    });
    const after = buildReport([r('a', 'passed'), r('b', 'pending')], {
      modes: ['offline'],
      model: 'none',
      commit: null,
    });
    expect(regressions(after, toBaseline(before))).toEqual([
      'b (offline) passed in the baseline and is pending now',
    ]);
    const worse = buildReport([r('a', 'passed'), r('b', 'failed')], {
      modes: ['offline'],
      model: 'none',
      commit: null,
    });
    expect(regressions(worse, toBaseline(before))).toEqual([
      'b (offline) passed in the baseline and is failed now',
      'offline pass rate dropped from 100.0% to 50.0%',
    ]);
    expect(regressions(before, toBaseline(before))).toEqual([]);
  });

  it('a one-mode baseline update keeps the other modes', () => {
    const old = toBaseline(
      buildReport([{ ...r('p', 'passed'), mode: 'pipeline' }, r('a', 'failed')], {
        modes: ['offline', 'pipeline'],
        model: 'none',
        commit: null,
      }),
    );
    const next = toBaseline(
      buildReport([r('a', 'passed')], { modes: ['offline'], model: 'none', commit: null }),
    );
    const merged = mergeBaseline(old, next, ['offline']);
    expect(merged.results.map((x) => `${x.mode}:${x.id}:${x.status}`)).toEqual([
      'offline:a:passed',
      'pipeline:p:passed',
    ]);
  });

  it('renders failures and pending reasons in Markdown', () => {
    const md = toMarkdown(
      buildReport([r('a', 'failed'), r('b', 'pending')], {
        modes: ['offline'],
        model: 'none',
        commit: 'abc',
      }),
    );
    expect(md).toContain('## Failures (1)');
    expect(md).toContain('result: expected plan, got deny');
    expect(md).toContain('## Pending (1)');
    expect(md).toContain('capability missing: tool:x');
  });
});
