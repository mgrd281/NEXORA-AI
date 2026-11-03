import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, type Preferences } from '@jarvis/contracts';
import { evaluatePolicy, type PolicyInput } from '../../../src/modules/agent/policy';

const OWNER = 'owner@example.com';

function prefs(
  patch: Partial<{ [K in keyof Preferences]: Partial<Preferences[K]> }> = {},
): Preferences {
  const out = structuredClone(DEFAULT_PREFERENCES) as Preferences;
  for (const [k, v] of Object.entries(patch)) Object.assign(out[k as keyof Preferences], v);
  return out;
}

function input(p: Partial<PolicyInput> = {}): PolicyInput {
  return {
    toolId: 'web.fetch',
    risk: 'LOW',
    requiredConnection: null,
    activeConnections: new Set(['web', 'smtp']),
    preferences: prefs(),
    accountEmail: OWNER,
    sideEffect: 'none',
    modelUse: 'none',
    model: { available: false, offlineReason: 'NO_API_KEY' },
    projectedCostMicro: 0,
    budget: { limitMicro: 20_000_000, spentMicro: 0 },
    ...p,
  };
}

const email = (to: string[], p: Partial<PolicyInput> = {}) =>
  input({
    toolId: 'email.send',
    risk: to.length > 3 ? 'HIGH' : 'MEDIUM',
    requiredConnection: 'smtp',
    sideEffect: 'external',
    recipients: to,
    ...p,
  });

describe('policy engine', () => {
  it('allows LOW risk', () => {
    expect(evaluatePolicy(input())).toEqual({
      decision: 'allow',
      reasons: ['RISK_LOW'],
      denyCode: null,
    });
  });

  it('denies when the required connection is missing or inactive', () => {
    const r = evaluatePolicy(
      input({ requiredConnection: 'smtp', activeConnections: new Set(['web']) }),
    );
    expect(r.decision).toBe('deny');
    expect(r.reasons).toEqual(['CONNECTION_MISSING']);
    expect(r.denyCode).toBe('CONNECTION_REQUIRED');
  });

  it('denies memory.save when memory is disabled, allows it otherwise', () => {
    const off = evaluatePolicy(
      input({
        toolId: 'memory.save',
        sideEffect: 'internal',
        preferences: prefs({ memory: { enabled: false } }),
      }),
    );
    expect(off).toMatchObject({
      decision: 'deny',
      reasons: ['MEMORY_DISABLED'],
      denyCode: 'POLICY_DENIED',
    });
    expect(evaluatePolicy(input({ toolId: 'memory.save', sideEffect: 'internal' })).decision).toBe(
      'allow',
    );
  });

  it('requires approval for MEDIUM risk email to an external recipient', () => {
    const r = evaluatePolicy(email(['friend@example.org']));
    expect(r.decision).toBe('require_approval');
    expect(r.reasons).toEqual(['RISK_MEDIUM', 'RECIPIENT_EXTERNAL']);
  });

  it('requires approval for email to self unless auto-approve is on', () => {
    expect(evaluatePolicy(email([OWNER])).decision).toBe('require_approval');
    expect(evaluatePolicy(email([OWNER])).reasons).toContain('RECIPIENT_SELF');
    const auto = evaluatePolicy(
      email(['Owner@Example.com '], {
        preferences: prefs({ autonomy: { autoApproveEmailToSelf: true } }),
      }),
    );
    expect(auto.decision).toBe('allow');
    expect(auto.reasons).toEqual(['RISK_MEDIUM', 'RECIPIENT_SELF', 'AUTO_APPROVED_SELF']);
  });

  it('auto-approve never applies when any recipient is external', () => {
    const r = evaluatePolicy(
      email([OWNER, 'x@evil.test'], {
        preferences: prefs({ autonomy: { autoApproveEmailToSelf: true } }),
      }),
    );
    expect(r.decision).toBe('require_approval');
    expect(r.reasons).toContain('RECIPIENT_EXTERNAL');
  });

  it('always requires approval for HIGH risk (more than 3 recipients), even to self', () => {
    const r = evaluatePolicy(
      email(['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test'], {
        preferences: prefs({ autonomy: { autoApproveEmailToSelf: true } }),
      }),
    );
    expect(r.decision).toBe('require_approval');
    expect(r.reasons).toEqual(['RISK_HIGH', 'RECIPIENT_EXTERNAL', 'MANY_RECIPIENTS']);
  });

  it('denies CRITICAL risk in this build', () => {
    expect(evaluatePolicy(input({ risk: 'CRITICAL' }))).toMatchObject({
      decision: 'deny',
      reasons: ['RISK_CRITICAL'],
      denyCode: 'POLICY_DENIED',
    });
  });

  it('requires approval when the projected cost exceeds the remaining budget', () => {
    const r = evaluatePolicy(
      input({
        toolId: 'text.summarize',
        modelUse: 'optional',
        model: { available: true, offlineReason: null },
        projectedCostMicro: 600,
        budget: { limitMicro: 1_000, spentMicro: 500 },
      }),
    );
    expect(r.decision).toBe('require_approval');
    expect(r.reasons).toEqual(['RISK_LOW', 'BUDGET_NEAR_LIMIT']);
  });

  it('ignores budget for steps that will not use a paid model', () => {
    const r = evaluatePolicy(
      input({
        toolId: 'text.summarize',
        modelUse: 'optional',
        model: { available: false, offlineReason: 'BUDGET_EXHAUSTED' },
        projectedCostMicro: 0,
        budget: { limitMicro: 0, spentMicro: 0 },
      }),
    );
    expect(r.decision).toBe('allow');
  });

  it('denies a step that needs a paid model when the budget is 0', () => {
    const r = evaluatePolicy(
      input({
        toolId: 'assistant.answer',
        modelUse: 'required',
        model: { available: false, offlineReason: 'BUDGET_EXHAUSTED' },
        budget: { limitMicro: 0, spentMicro: 0 },
      }),
    );
    expect(r).toMatchObject({
      decision: 'deny',
      reasons: ['BUDGET_ZERO'],
      denyCode: 'BUDGET_EXCEEDED',
    });
  });

  it('maps an unavailable model to the right deny code', () => {
    const base = { toolId: 'assistant.answer' as const, modelUse: 'required' as const };
    expect(
      evaluatePolicy(input({ ...base, model: { available: false, offlineReason: 'NO_API_KEY' } }))
        .denyCode,
    ).toBe('MODEL_NOT_CONFIGURED');
    expect(
      evaluatePolicy(
        input({
          ...base,
          model: { available: false, offlineReason: 'USER_DISABLED_EXTERNAL_MODELS' },
        }),
      ),
    ).toMatchObject({ reasons: ['EXTERNAL_MODELS_DISABLED'], denyCode: 'POLICY_DENIED' });
    expect(
      evaluatePolicy(
        input({
          ...base,
          model: { available: false, offlineReason: 'BUDGET_EXHAUSTED' },
          budget: { limitMicro: 5, spentMicro: 5 },
        }),
      ),
    ).toMatchObject({ reasons: ['BUDGET_EXHAUSTED'], denyCode: 'BUDGET_EXCEEDED' });
  });

  it('forces approval for external actions fed by suspected prompt injection, overriding auto-approve', () => {
    const r = evaluatePolicy(
      email([OWNER], {
        untrustedContent: true,
        preferences: prefs({ autonomy: { autoApproveEmailToSelf: true } }),
      }),
    );
    expect(r.decision).toBe('require_approval');
    expect(r.reasons).toContain('UNTRUSTED_CONTENT');
    expect(r.reasons).not.toContain('AUTO_APPROVED_SELF');
  });

  it('connection check wins over every other rule', () => {
    const r = evaluatePolicy(email([OWNER], { activeConnections: new Set(), risk: 'CRITICAL' }));
    expect(r.denyCode).toBe('CONNECTION_REQUIRED');
  });
});
