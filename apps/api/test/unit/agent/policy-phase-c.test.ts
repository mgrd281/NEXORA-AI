/**
 * Phase C policy rules (docs/architecture/phase-c.md §5): the exact
 * connection a step needs (missing / expired / capability), purchases
 * (scenario 7: an unauthorized purchase is refused), binding commitments and
 * calendar invitations — and that domain facts can only restrict.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  RISK_ORDER,
  type ConnectionCapability,
  type ConnectionProvider,
  type ConnectionStatus,
  type RiskLevel,
} from '@jarvis/contracts';
import { evaluatePolicy, type PolicyInput } from '../../../src/modules/agent/policy';
import { DOMAIN_RULES, evaluateDomainRules } from '../../../src/modules/agent/policy-domain';
import { satisfies } from '../../../src/modules/agent/tools/registry';
import type { ConnectionState } from '../../../src/modules/agent/tools/types';

const OWNER = 'owner@example.com';
const USD = (dollars: number) => Math.round(dollars * 1_000_000);

const conn = (
  provider: ConnectionProvider,
  status: ConnectionStatus = 'active',
  capabilities: ConnectionCapability[] = [],
): ConnectionState => ({
  connectionId: `00000000-0000-4000-8000-00000000000${provider.length}`,
  provider,
  status,
  capabilities,
  accountIdentifier: `${provider}@example.com`,
});

function input(p: Partial<PolicyInput> = {}): PolicyInput {
  return {
    toolId: 'calendar.list',
    risk: 'LOW',
    requiredConnection: null,
    activeConnections: new Set(['web']),
    preferences: structuredClone(DEFAULT_PREFERENCES),
    accountEmail: OWNER,
    sideEffect: 'none',
    modelUse: 'none',
    model: { available: false, offlineReason: 'NO_API_KEY' },
    projectedCostMicro: 0,
    budget: { limitMicro: 20_000_000, spentMicro: 0 },
    ...p,
  };
}

const checkout = (amount: number | null, limit: number, spent = 0, currency = 'USD') =>
  input({
    toolId: 'shop.checkout',
    risk: 'HIGH',
    requiredConnection: 'web',
    sideEffect: 'external',
    outbound: true,
    purchase: {
      amountMicro: amount === null ? null : USD(amount),
      currency: amount === null ? null : currency,
      limitMicro: USD(limit),
      spentMicro: USD(spent),
    },
  });

describe('connection requirement (rule 1, Phase C)', () => {
  const google = { provider: 'google' as const, capability: 'calendar.read' as const };

  it('denies a missing connection as before', () => {
    const r = evaluatePolicy(input({ requirement: google, connectionStates: [] }));
    expect(r).toMatchObject({ decision: 'deny', reasons: ['CONNECTION_MISSING'] });
    expect(r.denyCode).toBe('CONNECTION_REQUIRED');
    expect(r.denyParams).toEqual({ provider: 'google', capability: 'calendar.read' });
  });

  it('tells an expired OAuth connection apart (scenario 9: offer Reconnect)', () => {
    const r = evaluatePolicy(
      input({
        requirement: google,
        connectionStates: [conn('google', 'expired', ['calendar.read'])],
      }),
    );
    expect(r).toMatchObject({ decision: 'deny', reasons: ['CONNECTION_EXPIRED'] });
    expect(r.denyCode).toBe('CONNECTION_REQUIRED');
  });

  it('keeps an expired SMTP connection a missing one (Milestone 1 behaviour)', () => {
    const r = evaluatePolicy(
      input({
        toolId: 'email.send',
        requiredConnection: 'smtp',
        activeConnections: new Set(),
        connectionStates: [conn('smtp', 'expired')],
      }),
    );
    expect(r.reasons).toEqual(['CONNECTION_MISSING']);
  });

  it('denies a capability the connection does not grant', () => {
    const r = evaluatePolicy(
      input({
        requirement: { provider: 'google', capability: 'calendar.write' },
        activeConnections: new Set(['google']),
        connectionStates: [conn('google', 'active', ['calendar.read'])],
      }),
    );
    expect(r).toMatchObject({ decision: 'deny', reasons: ['CONNECTION_SCOPE_MISSING'] });
  });

  it('allows when the active connection grants the capability', () => {
    const r = evaluatePolicy(
      input({
        requirement: google,
        activeConnections: new Set(['google']),
        connectionStates: [conn('google', 'active', ['calendar.read'])],
      }),
    );
    expect(r.decision).toBe('allow');
  });

  it('never confirms a capability without the connection states', () => {
    const r = evaluatePolicy(
      input({ requirement: google, activeConnections: new Set(['google']) }),
    );
    expect(r.reasons).toEqual(['CONNECTION_MISSING']);
  });

  it('satisfies() needs the provider active and the capability granted', () => {
    const states = [
      conn('google', 'active', ['mail.read']),
      conn('microsoft', 'expired', ['mail.send']),
    ];
    const active = new Set<ConnectionProvider>(['google']);
    expect(satisfies({ provider: 'google', capability: 'mail.read' }, states, active)).toBe(true);
    expect(satisfies({ provider: 'google', capability: 'mail.send' }, states, active)).toBe(false);
    expect(satisfies({ provider: 'microsoft', capability: 'mail.send' }, states, active)).toBe(
      false,
    );
    expect(satisfies({ provider: 'smtp' }, undefined, new Set(['smtp']))).toBe(true);
  });
});

describe('purchases (scenario 7: reject an unauthorized purchase)', () => {
  it('are off by default: a monthly limit of 0 denies every purchase', () => {
    expect(DEFAULT_PREFERENCES.spending.monthlyPurchaseLimitUsd).toBe(0);
    const r = evaluatePolicy(checkout(12.5, 0));
    expect(r).toMatchObject({ decision: 'deny', reasons: ['PURCHASES_DISABLED'] });
    expect(r.denyCode).toBe('POLICY_DENIED');
    // Even before the amount is known (planning time).
    expect(evaluatePolicy(checkout(null, 0)).reasons).toEqual(['PURCHASES_DISABLED']);
  });

  it('deny a purchase over what is left of the month, with the facts', () => {
    const r = evaluatePolicy(checkout(80, 100, 30));
    expect(r).toMatchObject({ decision: 'deny', reasons: ['PURCHASE_LIMIT'] });
    expect(r.denyParams).toEqual({ limit: 'USD 100.00', spent: 'USD 30.00', amount: 'USD 80.00' });
    // Exactly at the limit is allowed (with approval).
    expect(evaluatePolicy(checkout(70, 100, 30)).decision).toBe('require_approval');
  });

  it('deny other currencies (the limit is in USD; no verifiable exchange rate)', () => {
    const r = evaluatePolicy(checkout(10, 100, 0, 'EUR'));
    expect(r).toMatchObject({ decision: 'deny', reasons: ['PURCHASE_CURRENCY'] });
    expect(r.denyParams).toEqual({ currency: 'EUR' });
  });

  it('always need an approval within the limit — whatever the risk or autonomy settings', () => {
    for (const risk of ['LOW', 'MEDIUM', 'HIGH'] as RiskLevel[]) {
      const p = checkout(10, 100);
      p.risk = risk;
      p.preferences.autonomy.autoApproveEmailToSelf = true;
      const r = evaluatePolicy(p);
      expect(r.decision, risk).toBe('require_approval');
      expect(r.reasons).toContain('PURCHASE');
    }
    // Amount unknown at planning time: asked now, checked against the limit at execution.
    expect(evaluatePolicy(checkout(null, 100)).reasons).toContain('PURCHASE');
  });

  it('a negative or non-finite amount is never under the limit', () => {
    const p = checkout(1, 100);
    p.purchase!.amountMicro = -5;
    expect(evaluatePolicy(p).reasons).toEqual(['PURCHASE_LIMIT']);
    p.purchase!.amountMicro = Number.NaN;
    expect(evaluatePolicy(p).reasons).toEqual(['PURCHASE_LIMIT']);
  });

  it('money transfers stay CRITICAL and denied, purchase limit or not', () => {
    const p = checkout(10, 10_000);
    p.risk = 'CRITICAL';
    expect(evaluatePolicy(p).reasons).toEqual(['RISK_CRITICAL']);
  });
});

describe('binding commitments and invitations', () => {
  it('a binding booking needs an approval (BINDING_COMMITMENT)', () => {
    const r = evaluatePolicy(
      input({ toolId: 'booking.book', risk: 'LOW', sideEffect: 'external', binding: true }),
    );
    expect(r.decision).toBe('require_approval');
    expect(r.reasons).toContain('BINDING_COMMITMENT');
  });

  it('inviting anyone but the owner adds RECIPIENT_EXTERNAL and asks', () => {
    const r = evaluatePolicy(
      input({
        toolId: 'calendar.create_event',
        risk: 'LOW',
        sideEffect: 'external',
        attendees: ['Owner@Example.com', 'bob@example.org'],
      }),
    );
    expect(r.decision).toBe('require_approval');
    expect(r.reasons).toContain('RECIPIENT_EXTERNAL');
    const self = evaluatePolicy(
      input({ toolId: 'calendar.create_event', risk: 'LOW', attendees: [OWNER] }),
    );
    expect(self.decision).toBe('allow');
    const many = evaluatePolicy(
      input({
        toolId: 'calendar.create_event',
        attendees: ['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test'],
      }),
    );
    expect(many.reasons).toEqual(expect.arrayContaining(['RECIPIENT_EXTERNAL', 'MANY_RECIPIENTS']));
  });
});

describe('domain rules only restrict', () => {
  const facts: Partial<PolicyInput>[] = [
    {},
    { binding: true },
    { binding: false },
    { attendees: [] },
    { attendees: [OWNER] },
    { attendees: ['x@y.test'] },
    { purchase: { amountMicro: 1, currency: 'USD', limitMicro: USD(100), spentMicro: 0 } },
    { purchase: { amountMicro: null, currency: null, limitMicro: USD(100), spentMicro: 0 } },
  ];
  const bases: PolicyInput[] = [
    input(),
    input({ risk: 'MEDIUM', sideEffect: 'external' }),
    input({ risk: 'HIGH', sideEffect: 'external' }),
    input({ risk: 'CRITICAL' }),
    input({ requiredConnection: 'smtp', activeConnections: new Set() }),
  ];

  it('never turn a deny into an allow, remove an approval reason or change the risk', () => {
    for (const base of bases) {
      const without = evaluatePolicy(base);
      for (const f of facts) {
        const withFacts = evaluatePolicy({ ...base, ...f });
        if (without.decision === 'deny') expect(withFacts.decision).toBe('deny');
        if (without.decision === 'require_approval') expect(withFacts.decision).not.toBe('allow');
        if (withFacts.decision !== 'deny' && without.decision !== 'deny')
          for (const r of without.reasons) expect(withFacts.reasons).toContain(r);
        expect(RISK_ORDER[base.risk]).toBe(RISK_ORDER[{ ...base, ...f }.risk]);
      }
    }
  });

  it('cannot express an allow at all', () => {
    for (const rule of DOMAIN_RULES)
      for (const f of facts) {
        const v = rule(input(f));
        if (v)
          expect(Object.keys(v).every((k) => ['deny', 'approval', 'info'].includes(k))).toBe(true);
      }
    expect(evaluateDomainRules(input())).toEqual({ deny: null, approval: [], info: [] });
  });
});

describe('connection options (no exact requirement bound)', () => {
  const options = [
    { provider: 'google' as const, capability: 'calendar.read' as const },
    { provider: 'microsoft' as const, capability: 'calendar.read' as const },
  ];

  it('needs at least one option, explaining the most specific failure', () => {
    expect(
      evaluatePolicy(input({ connectionOptions: options, connectionStates: [] })).reasons,
    ).toEqual(['CONNECTION_MISSING']);
    expect(
      evaluatePolicy(
        input({
          connectionOptions: options,
          connectionStates: [conn('microsoft', 'expired', ['calendar.read'])],
        }),
      ).reasons,
    ).toEqual(['CONNECTION_EXPIRED']);
    expect(
      evaluatePolicy(
        input({
          connectionOptions: options,
          activeConnections: new Set(['google']),
          connectionStates: [conn('google', 'active', ['mail.read'])],
        }),
      ).reasons,
    ).toEqual(['CONNECTION_SCOPE_MISSING']);
  });

  it('allows when one option is satisfied, and an exact requirement still wins', () => {
    const states = [conn('microsoft', 'active', ['calendar.read'])];
    const active = new Set<ConnectionProvider>(['microsoft']);
    expect(
      evaluatePolicy(
        input({ connectionOptions: options, activeConnections: active, connectionStates: states }),
      ).decision,
    ).toBe('allow');
    expect(
      evaluatePolicy(
        input({
          connectionOptions: options,
          requirement: options[0],
          activeConnections: active,
          connectionStates: states,
        }),
      ).reasons,
    ).toEqual(['CONNECTION_MISSING']);
  });
});
