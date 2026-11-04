/**
 * Phase D policy and planning rules for phone calls (docs/architecture/phase-d.md §5):
 * the call rule (telephony configured, destination, do-not-call, calling hours, daily limit,
 * approvals that are never automatic), the facts assessStep computes for it, and plan
 * validation's number literalness — exercised with a synthetic phone.call tool, so the hooks
 * are frozen before the real tool lands.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  PhoneCallInput,
  type CallScript,
  type PhoneCallInput as PhoneCallInputT,
} from '@jarvis/contracts';
import { phoneHashKey, phoneNumberHash } from '../../../src/lib/phone';
import type { AgentContext, TelephonyContext } from '../../../src/modules/agent/context';
import { evaluatePolicy, denyReason, type PolicyInput } from '../../../src/modules/agent/policy';
import { DOMAIN_RULES } from '../../../src/modules/agent/policy-domain';
import { callRule, type CallPolicyFacts } from '../../../src/modules/agent/policy-telephony';
import { validatePlan } from '../../../src/modules/agent/plan';
import { assessStep, callPolicyFacts } from '../../../src/modules/agent/step-policy';
import { genericApprovalSummary, type AnyTool } from '../../../src/modules/agent/tools/types';
import { loadConfig } from '../../../src/config';

const OWNER = 'owner@example.com';
const NUMBER = '+493012345678';
const config = loadConfig({
  DATABASE_URL: 'postgresql://x:x@localhost:5432/x',
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
});

const facts = (p: Partial<CallPolicyFacts> = {}): CallPolicyFacts => ({
  configured: true,
  to: NUMBER,
  masked: '+49 30 •••••• 78',
  destination: { ok: true },
  doNotCall: false,
  withinHours: true,
  hours: { start: '08:00', end: '20:00', timeZone: 'Europe/Berlin' },
  callsToday: 0,
  maxPerDay: 10,
  recording: false,
  sharesPersonalInfo: false,
  ...p,
});

function input(call: CallPolicyFacts | null, p: Partial<PolicyInput> = {}): PolicyInput {
  return {
    toolId: 'phone.call',
    risk: 'MEDIUM',
    requiredConnection: null,
    activeConnections: new Set(['web']),
    preferences: structuredClone(DEFAULT_PREFERENCES),
    accountEmail: OWNER,
    sideEffect: 'external',
    modelUse: 'optional',
    model: { available: false, offlineReason: 'NO_API_KEY' },
    projectedCostMicro: 0,
    budget: { limitMicro: 20_000_000, spentMicro: 0 },
    call,
    ...p,
  };
}

describe('call rule (policy-telephony.ts)', () => {
  it('asks before every call, never automatically', () => {
    const r = evaluatePolicy(input(facts()));
    expect(r.decision).toBe('require_approval');
    expect(r.reasons).toEqual(expect.arrayContaining(['RISK_MEDIUM', 'PHONE_CALL']));
    // Even the email-to-self autonomy cannot apply to a call.
    const prefs = structuredClone(DEFAULT_PREFERENCES);
    prefs.autonomy.autoApproveEmailToSelf = true;
    expect(evaluatePolicy(input(facts(), { preferences: prefs })).decision).toBe(
      'require_approval',
    );
    expect(evaluatePolicy(input(facts(), { risk: 'LOW' })).decision).toBe('require_approval');
  });

  it('adds the reasons for recording, shared details and binding commitments', () => {
    const r = evaluatePolicy(
      input(facts({ recording: true, sharesPersonalInfo: true }), { risk: 'HIGH', binding: true }),
    );
    expect(r.decision).toBe('require_approval');
    expect(r.reasons).toEqual(
      expect.arrayContaining([
        'RISK_HIGH',
        'PHONE_CALL',
        'CALL_RECORDING',
        'CALL_PERSONAL_INFO',
        'BINDING_COMMITMENT',
      ]),
    );
  });

  it('denies in a fixed order with precise, explainable reasons', () => {
    const cases: [Partial<CallPolicyFacts>, string, Record<string, unknown>][] = [
      [{ configured: false }, 'TELEPHONY_NOT_CONFIGURED', {}],
      [
        { destination: { ok: false, reason: 'type', country: 'DE' } },
        'CALL_DESTINATION_BLOCKED',
        { country: 'DE' },
      ],
      [{ doNotCall: true }, 'DO_NOT_CALL', { number: '+49 30 •••••• 78' }],
      [
        { withinHours: false },
        'CALL_OUTSIDE_HOURS',
        { start: '08:00', end: '20:00', timeZone: 'Europe/Berlin' },
      ],
      [{ withinHours: null }, 'CALL_OUTSIDE_HOURS', {}],
      [{ callsToday: 10 }, 'CALL_LIMIT', { max: 10 }],
    ];
    for (const [over, reason, params] of cases) {
      const r = evaluatePolicy(input(facts(over)));
      expect(r.decision, reason).toBe('deny');
      expect(r.reasons, reason).toEqual([reason]);
      expect(r.denyCode, reason).toBe('POLICY_DENIED');
      expect(r.denyParams ?? {}, reason).toMatchObject(params);
      expect(denyReason(r.denyCode!, r.reasons), reason).toBe(reason);
    }
    // Not configured wins over everything else.
    expect(
      evaluatePolicy(input(facts({ configured: false, doNotCall: true, callsToday: 99 }))).reasons,
    ).toEqual(['TELEPHONY_NOT_CONFIGURED']);
  });

  it('can only restrict: no fact turns a deny into an allow or removes an approval', () => {
    expect(DOMAIN_RULES).toContain(callRule);
    for (const f of [facts(), facts({ recording: true }), facts({ doNotCall: true })]) {
      const v = callRule(input(f));
      expect(v && 'allow' in v).toBeFalsy();
    }
    expect(callRule(input(null))).toBeNull();
  });
});

const telephony = (p: Partial<TelephonyContext> = {}): TelephonyContext => ({
  configured: true,
  allowedCountries: new Set(['DE']),
  allowedHours: { start: '08:00', end: '20:00' },
  maxPerDay: 10,
  callsToday: 0,
  doNotCall: new Set(),
  ownPhone: null,
  now: new Date('2026-11-04T09:00:00Z'), // 10:00 in Berlin
  ...p,
});

const account = {
  userId: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  email: OWNER,
  displayName: 'Alex Doe',
  locale: 'en' as const,
  timeZone: 'Europe/Berlin',
};

const callFacts = {
  to: NUMBER,
  calleeTimeZone: null,
  purpose: 'availability' as const,
  recording: 'off' as const,
  sharedDetails: 0,
  allowTransfer: false,
};

describe('call facts (step-policy.ts callPolicyFacts)', () => {
  it('derives destination, do-not-call, hours and limits from the context', () => {
    const ok = callPolicyFacts(callFacts, { telephony: telephony(), account }, config);
    expect(ok).toMatchObject({
      configured: true,
      destination: { ok: true },
      doNotCall: false,
      withinHours: true,
      hours: { start: '08:00', end: '20:00', timeZone: 'Europe/Berlin' },
    });
    expect(ok.masked).not.toContain('1234567');
    const key = phoneHashKey(config.SECRET_ENCRYPTION_KEY);
    const listed = telephony({
      doNotCall: new Set([phoneNumberHash(key, NUMBER).toString('hex')]),
    });
    expect(callPolicyFacts(callFacts, { telephony: listed, account }, config).doNotCall).toBe(true);
    // 21:00 in Berlin; and the callee's own zone decides when it is given.
    const late = telephony({ now: new Date('2026-11-04T20:00:00Z') });
    expect(callPolicyFacts(callFacts, { telephony: late, account }, config).withinHours).toBe(
      false,
    );
    expect(
      callPolicyFacts(
        { ...callFacts, calleeTimeZone: 'America/New_York' },
        { telephony: late, account },
        config,
      ).withinHours,
    ).toBe(true);
    expect(
      callPolicyFacts(
        { ...callFacts, calleeTimeZone: 'Not/AZone' },
        { telephony: telephony(), account },
        config,
      ).withinHours,
    ).toBeNull();
  });

  it('blocks premium-rate numbers and countries the server does not call', () => {
    const premium = callPolicyFacts(
      { ...callFacts, to: '+499001234567' },
      { telephony: telephony(), account },
      config,
    );
    expect(premium.destination).toEqual({ ok: false, reason: 'type', country: 'DE' });
    const abroad = callPolicyFacts(
      { ...callFacts, to: '+442079460958' },
      { telephony: telephony(), account },
      config,
    );
    expect(abroad.destination).toEqual({ ok: false, reason: 'country', country: 'GB' });
  });

  it('without a telephony context nothing is configured (deny), never an allow', () => {
    const f = callPolicyFacts(callFacts, { account }, config);
    expect(f.configured).toBe(false);
    expect(evaluatePolicy(input(f)).reasons).toEqual(['TELEPHONY_NOT_CONFIGURED']);
  });
});

const SCRIPT: CallScript = {
  opening: 'Hello, this is JARVIS, an AI assistant calling on behalf of Alex Doe.',
  recordingQuestion: null,
  message: null,
  questions: ['Which times do you have free on Tuesday?'],
  closing: 'Thank you. Goodbye.',
  voicemailMessage: null,
};

/** phone.call as the telephony engineer will declare it (only the planning / policy hooks matter). */
function phoneTool(throwing = false): AnyTool {
  return {
    id: 'phone.call',
    version: '0.0.0-test',
    description: 'test',
    inputSchema: PhoneCallInput,
    outputFields: ['callId', 'result', 'text'],
    requiredConnection: null,
    needsTelephony: true,
    phoneNumbers: (i: PhoneCallInputT) => [i.to],
    call: (i: PhoneCallInputT) => {
      if (throwing) throw new Error('unreadable');
      return {
        to: i.to,
        calleeTimeZone: i.calleeTimeZone,
        purpose: i.purpose,
        recording: i.recording,
        sharedDetails: i.shareInfo.length,
        allowTransfer: i.allowTransfer,
      };
    },
    binding: (i: PhoneCallInputT) => i.purpose === 'appointment',
    bind: (i: PhoneCallInputT) => ({ ...i, script: i.script ?? SCRIPT }),
    permissions: [],
    sideEffect: 'external',
    idempotency: 'once_per_step',
    timeoutMs: 1000,
    retry: { maxAttempts: 1, retryableCodes: [] },
    modelUse: 'optional',
    riskLevel: (i: PhoneCallInputT) => (i.purpose === 'appointment' ? 'HIGH' : 'MEDIUM'),
    estimateCostMicro: () => 0,
    preview: (i: PhoneCallInputT) => ({ to: i.to }),
    approvalDetails: (_i, c) => ({
      details: { kind: 'generic', toolId: 'phone.call', fields: [] },
      ...genericApprovalSummary(c, 'phone.call'),
    }),
    execute: () => Promise.reject(new Error('not run in this test')),
    verify: () => ({ ok: true, checks: [] }),
  };
}

const callInput = (over: Partial<PhoneCallInputT> = {}) => ({
  to: NUMBER,
  language: 'en',
  purpose: 'availability',
  goal: 'Ask for a free appointment on Tuesday',
  ...over,
});

const planOf = (input: Record<string, unknown>) => ({
  title: 'Call the dentist',
  objective: 'Ask for an appointment',
  steps: [{ key: 's1', toolId: 'phone.call', title: 'Call my dentist', input }],
});

const validation = (requests: string[], phoneRegion: string | null = null) => ({
  tools: new Map([['phone.call', phoneTool()]]),
  ownEmail: OWNER,
  requests,
  bind: { connections: [], accountEmail: OWNER, timeZone: 'Europe/Berlin' },
  phoneRegion,
});

describe('number literalness (plan.ts)', () => {
  it('accepts the number exactly as the user wrote it, in any common spelling', () => {
    for (const written of ['+49 30 12345678', '+49 (0)30 1234 5678', '0049 30 12345678'])
      expect(
        validatePlan(planOf(callInput()), validation([`call my dentist on ${written}`])).ok,
        written,
      ).toBe(true);
    // A national number counts only with the default country of the account's own number.
    const national = ['ruf meine Zahnärztin unter 030 12345678 an'];
    expect(validatePlan(planOf(callInput()), validation(national)).ok).toBe(false);
    expect(validatePlan(planOf(callInput()), validation(national, 'DE')).ok).toBe(true);
  });

  it('refuses a number the user did not write (a result, a page, a callee, the model)', () => {
    const r = validatePlan(
      planOf(callInput({ to: '+442079460958' })),
      validation(['call my dentist +49 30 12345678 and ask for Tuesday']),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join('\n')).toMatch(/is not written in the user’s requests/);
    const ref = validatePlan(
      planOf(callInput({ to: '{{s0.number}}' })),
      validation(['call the number from the page']),
    );
    expect(ref.ok).toBe(false);
  });

  it('binds the script into the stored input, so the approval hash covers the exact words', () => {
    const r = validatePlan(planOf(callInput()), validation(['call +49 30 12345678']));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.steps[0]!.input).toMatchObject({ script: SCRIPT, dialog: 'scripted' });
  });
});

describe('assessStep with a call step', () => {
  const agent = (t?: TelephonyContext): AgentContext => ({
    account,
    preferences: structuredClone(DEFAULT_PREFERENCES),
    connections: new Map(),
    budget: { limitMicro: 20_000_000, spentMicro: 0 },
    route: { mode: 'offline', provider: null, reason: 'NO_API_KEY' } as AgentContext['route'],
    connectionStates: [],
    telephony: t,
  });
  const parsed = PhoneCallInput.parse({ ...callInput(), script: SCRIPT }) as Record<
    string,
    unknown
  >;

  it('asks for approval inside the hours and denies outside them', () => {
    const tool = phoneTool();
    expect(assessStep(tool, parsed, agent(telephony()), config).policy.decision).toBe(
      'require_approval',
    );
    const late = assessStep(
      tool,
      parsed,
      agent(telephony({ now: new Date('2026-11-04T20:30:00Z') })),
      config,
    );
    expect(late.policy.reasons).toEqual(['CALL_OUTSIDE_HOURS']);
  });

  it('a call declaration that throws is denied (an invalid number), never allowed', () => {
    const r = assessStep(phoneTool(true), parsed, agent(telephony()), config);
    expect(r.policy.decision).toBe('deny');
    expect(r.policy.reasons).toEqual(['CALL_DESTINATION_BLOCKED']);
  });

  it('a binding call (appointment) is HIGH with BINDING_COMMITMENT', () => {
    const booking = PhoneCallInput.parse({
      ...callInput({ purpose: 'appointment' }),
      script: SCRIPT,
    }) as Record<string, unknown>;
    const r = assessStep(phoneTool(), booking, agent(telephony()), config);
    expect(r.risk).toBe('HIGH');
    expect(r.policy.reasons).toEqual(expect.arrayContaining(['PHONE_CALL', 'BINDING_COMMITMENT']));
  });
});
