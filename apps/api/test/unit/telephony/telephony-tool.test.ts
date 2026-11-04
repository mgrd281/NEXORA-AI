/**
 * phone.call as the planner, the Policy Engine and the executor see it (no database): the
 * offline intents (en/de/ar), plan validation's number literalness, bind (the script fixed in
 * the input, the disclosure first, the planner's own words replaced), the approval details,
 * the policy decision on the real tool, verification and the step errors of every result.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, type CallOutcome } from '@jarvis/contracts';
import { loadConfig } from '../../../src/config';
import type { CallSessionRow } from '../../../src/db/types';
import { phoneHashKey, phoneNumberHash } from '../../../src/lib/phone';
import type { AgentContext } from '../../../src/modules/agent/context';
import { planOffline } from '../../../src/modules/agent/models/offline';
import { validatePlan } from '../../../src/modules/agent/plan';
import { assessStep } from '../../../src/modules/agent/step-policy';
import {
  callError,
  outcomeText,
  phoneCallTool,
} from '../../../src/modules/agent/tools/telephony/phone-call';
import { availableTools, TOOLS } from '../../../src/modules/agent/tools/registry';

const config = loadConfig({
  DATABASE_URL: 'postgresql://x:x@localhost:5432/x',
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
  TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'unit-test-auth-token-xx',
  TWILIO_FROM_NUMBER: '+4930901820',
  PUBLIC_WEBHOOK_BASE_URL: 'https://api.example.test',
});
const OWN = 'owner@example.test';
const bind = {
  connections: [],
  accountEmail: OWN,
  ownName: 'Alex Example',
  timeZone: 'Europe/Berlin',
  modelAvailable: false,
  locale: 'en' as const,
};

function offline(request: string, language: 'en' | 'de' | 'ar', phoneRegion: string | null = null) {
  const r = planOffline(request, {
    language,
    ownEmail: OWN,
    ownName: 'Alex Example',
    timeZone: 'Europe/Berlin',
    telephonyAvailable: true,
    phoneRegion,
  });
  if (!r.ok) return r;
  const v = validatePlan(r.plan, {
    tools: TOOLS,
    requests: [request],
    ownEmail: OWN,
    bind: { ...bind, locale: language },
    phoneRegion,
  });
  return v;
}

describe('offline intents (en/de/ar)', () => {
  it.each([
    ['call +49 30 1234567 and ask if they have an appointment on Friday', 'en', 'availability'],
    [
      'Ruf +49 30 1234567 an und frag, ob sie am Freitag einen Termin frei haben',
      'de',
      'availability',
    ],
    ['اتصل بالرقم +49 30 1234567 واسأل إن كان لديهم موعد متاح يوم الجمعة', 'ar', 'availability'],
    ['Call Dr. Weber at +49 30 1234567 and tell them I will be late', 'en', 'message'],
    ['Ruf +49 30 1234567 an und sag ihnen, dass ich später komme', 'de', 'message'],
    ['اتصل بـ +49 30 1234567 وقل لهم إنني سأتأخر', 'ar', 'message'],
    ['Call +44 20 7946 0958 and ask: Do you still have the blue sofa?', 'en', 'questions'],
  ] as const)('%s', (request, language, purpose) => {
    const v = offline(request, language);
    expect(v.ok).toBe(true);
    if (!v.ok || !('plan' in v)) return;
    const step = v.plan.steps[0]!;
    expect(step.toolId).toBe('phone.call');
    expect(step.titleMessage).toMatchObject({ key: 'step.call' });
    expect(step.input).toMatchObject({
      purpose,
      language,
      dialog: 'scripted',
      recording: 'off',
      calleeTimeZone: 'Europe/Berlin',
    });
    const opening = (step.input.script as { opening: string }).opening;
    expect(opening).toContain('JARVIS');
    expect(opening).toContain('Alex Example');
  });
  it('asks instead of guessing', () => {
    expect(
      planOffline('Call my dentist and tell them I am late', { language: 'en', ownEmail: OWN }),
    ).toMatchObject({
      ok: true,
      plan: { steps: [{ toolId: 'assistant.clarify', input: { missing: ['phone_number'] } }] },
    });
    expect(planOffline('Ruf +49 30 1234567 an', { language: 'de', ownEmail: OWN })).toMatchObject({
      ok: true,
      plan: { steps: [{ toolId: 'assistant.clarify', input: { missing: ['call_goal'] } }] },
    });
    // A national number is read only in the country of the account's own number.
    expect(offline('Ruf 030 1234567 an und sag ihnen, dass ich später komme', 'de', 'DE').ok).toBe(
      true,
    );
  });
  it('a binding booking by phone needs the model (honest unsupported offline)', () => {
    expect(
      planOffline('Call my dentist and move my appointment to next week', {
        language: 'en',
        ownEmail: OWN,
      }),
    ).toMatchObject({
      ok: false,
      reason: 'OFFLINE_UNSUPPORTED',
    });
  });
});

describe('plan validation: only numbers the user wrote', () => {
  const plan = (to: string) => ({
    title: 'Call',
    objective: 'Call',
    steps: [
      {
        key: 's1',
        toolId: 'phone.call',
        title: 'Call',
        input: { to, language: 'en', purpose: 'message', goal: 'say hi', message: 'Hi' },
      },
    ],
  });
  it('accepts the written number, refuses any other (NUMBER_NOT_LITERAL)', () => {
    const ctx = {
      tools: TOOLS,
      requests: ['Call 0049 30 1234567 and say hi'],
      ownEmail: OWN,
      bind,
    };
    expect(validatePlan(plan('+49301234567'), ctx).ok).toBe(true);
    const bad = validatePlan(plan('+49309999999'), ctx);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.issues.join(' ')).toMatch(/is not written in the user’s requests/);
    // References are never accepted for a number or the words.
    const ref = validatePlan(
      {
        ...plan('+49301234567'),
        steps: [
          {
            ...plan('+49301234567').steps[0]!,
            input: { ...plan('+49301234567').steps[0]!.input, message: '{{s0.text}}' },
          },
        ],
      },
      ctx,
    );
    expect(ref.ok).toBe(false);
  });
  it('is hidden from the planner without telephony', () => {
    const opts = { activeConnections: new Set<never>(), memoryEnabled: true, modelAvailable: true };
    expect(
      availableTools({ ...opts, telephonyAvailable: false }).some((t) => t.id === 'phone.call'),
    ).toBe(false);
    expect(
      availableTools({ ...opts, telephonyAvailable: true }).some((t) => t.id === 'phone.call'),
    ).toBe(true);
  });
});

describe('bind, approval, policy', () => {
  const planned = phoneCallTool.inputSchema.parse({
    to: '+49301234567',
    calleeName: 'Dr. Weber',
    language: 'de',
    purpose: 'availability',
    goal: 'Termin am Freitag',
    date: '2026-11-13',
    shareInfo: [{ label: 'Name', value: 'Alex Example' }],
    recording: 'if_consented',
    script: {
      opening: 'Hallo, ich bin ein Mensch.',
      recordingQuestion: null,
      message: null,
      questions: [],
      closing: 'Tschüss',
      voicemailMessage: null,
    },
  });
  const bound = phoneCallTool.bind!(planned, { ...bind, modelAvailable: true });
  it('fixes the zone, the dialog mode and the exact script (the planner never writes the words)', () => {
    expect(bound.calleeTimeZone).toBe('Europe/Berlin');
    expect(bound.dialog).toBe('model');
    expect(bound.script!.opening).toMatch(
      /^Guten Tag, hier ist JARVIS, ein KI-Assistent, der im Auftrag von Alex Example anruft\./,
    );
    expect(bound.script!.recordingQuestion).toMatch(/aufzeichnen/);
    expect(phoneCallTool.bind!(planned, bind).dialog).toBe('scripted');
  });
  it('shows every detail in the approval', () => {
    const { details, summaryMessage } = phoneCallTool.approvalDetails(bound, {
      language: 'de',
      stepTitle: 'Anruf',
      stepTitleMessage: null,
      fromAddress: null,
      account: { email: OWN, timeZone: 'Europe/Berlin' },
      telephony: {
        configured: true,
        callerId: '+4930901820',
        onBehalfOf: 'Alex Example',
        transferTo: null,
        allowedHours: { start: '08:00', end: '20:00' },
        pricePerMinuteMicroUsd: 20_000,
        maxCallSeconds: 120,
      },
    });
    expect(details).toMatchObject({
      kind: 'phone_call',
      to: '+49301234567',
      toDisplay: '+49 30 1234567',
      calleeName: 'Dr. Weber',
      onBehalfOf: 'Alex Example',
      callerId: '+4930901820',
      recording: 'if_consented',
      shareInfo: [{ label: 'Name', value: 'Alex Example' }],
      maxDurationSeconds: 120,
      costEstimate: { amountMicro: 40_000, currency: 'USD' },
      allowedHours: { start: '08:00', end: '20:00', timeZone: 'Europe/Berlin' },
      script: bound.script,
    });
    expect(summaryMessage).toMatchObject({
      key: 'approval.call',
      params: { who: 'Dr. Weber', number: '+49301234567' },
    });
  });
  it('the real tool is always approved, with recording and shared details named; denied on do-not-call', () => {
    const agent: AgentContext = {
      account: {
        userId: 'u',
        tenantId: 't',
        email: OWN,
        displayName: 'Alex',
        locale: 'de',
        timeZone: 'Europe/Berlin',
      },
      preferences: DEFAULT_PREFERENCES,
      connections: new Map(),
      budget: { limitMicro: 10_000_000, spentMicro: 0 },
      route: { mode: 'offline', provider: null, reason: 'NO_API_KEY' },
      telephony: {
        configured: true,
        allowedCountries: new Set(['DE']),
        allowedHours: { start: '00:00', end: '23:59' },
        maxPerDay: 10,
        callsToday: 0,
        doNotCall: new Set(),
        ownPhone: null,
      },
    };
    const a = assessStep(phoneCallTool, bound, agent, config);
    expect(a.policy.decision).toBe('require_approval');
    expect(a.policy.reasons).toEqual(
      expect.arrayContaining(['PHONE_CALL', 'CALL_RECORDING', 'CALL_PERSONAL_INFO', 'RISK_MEDIUM']),
    );
    const hash = phoneNumberHash(
      phoneHashKey(config.SECRET_ENCRYPTION_KEY),
      '+49301234567',
    ).toString('hex');
    const denied = assessStep(
      phoneCallTool,
      bound,
      { ...agent, telephony: { ...agent.telephony!, doNotCall: new Set([hash]) } },
      config,
    );
    expect(denied.policy).toMatchObject({ decision: 'deny', reasons: ['DO_NOT_CALL'] });
    const appointment = phoneCallTool.bind!({ ...planned, purpose: 'appointment' }, bind);
    const high = assessStep(phoneCallTool, appointment, agent, config);
    expect(high.risk).toBe('HIGH');
    expect(high.policy.reasons).toEqual(expect.arrayContaining(['BINDING_COMMITMENT']));
  });
});

describe('verification and step errors', () => {
  const ok = {
    callSid: `CA${'2'.repeat(32)}`,
    disclosure: { sequence: 0 },
    result: 'completed',
    turns: 5,
    consent: 'not_asked',
    recorded: false,
    goalReached: true,
    times: ['09:30'],
  };
  it('a call without its disclosure turn never counts as done', () => {
    expect(phoneCallTool.verify({} as never, ok).ok).toBe(true);
    const v = phoneCallTool.verify({} as never, { ...ok, disclosure: null });
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.key === 'aiDisclosed')!.text).toBe('No AI disclosure turn');
    expect(
      phoneCallTool.verify({} as never, { ...ok, recorded: true, consent: 'declined' }).ok,
    ).toBe(false);
  });
  const row = (result: string, failure: string | null, notes: string[] = []) =>
    ({
      result,
      failure_reason: failure,
      max_duration_seconds: 120,
      status_timeline: [{ status: 'ended', providerStatus: 'failed', sequence: 3, at: '' }],
      outcome: {
        result,
        goalReached: false,
        notes,
        details: {},
        summaryMessage: null,
      } as unknown as CallOutcome,
    }) as unknown as CallSessionRow;
  it.each([
    ['busy', 'CALL_BUSY', 'CALL_BUSY', true],
    ['no_answer', 'CALL_NO_ANSWER', 'CALL_NO_ANSWER', true],
    ['failed', 'CALL_FAILED', 'CALL_FAILED', true],
    ['voicemail', 'CALL_VOICEMAIL', 'CALL_VOICEMAIL', true],
    ['hung_up', 'CALL_HUNG_UP', 'CALL_HUNG_UP', true],
    ['declined', 'CALL_DECLINED', 'CALL_DECLINED', false],
    ['declined', 'RECORDING_CONSENT_DECLINED', 'RECORDING_CONSENT_DECLINED', false],
  ] as const)('%s / %s → %s (retryable %s)', (result, failure, reason, retryable) => {
    expect(callError(row(result, failure))!.toTaskError()).toMatchObject({
      code: 'TOOL_FAILED',
      reason,
      retryable,
    });
  });
  it('success, and the duration limit before the goal', () => {
    expect(callError(row('completed', null))).toBeNull();
    expect(callError(row('answered', null, ['DURATION_LIMIT']))!.toTaskError()).toMatchObject({
      reason: 'CALL_DURATION_LIMIT',
      params: { seconds: 120 },
    });
  });
  it('tells the user what the call brought, in their language', () => {
    const outcome: CallOutcome = {
      result: 'completed',
      goalReached: true,
      details: {
        date: '2026-11-13',
        times: ['09:30', '14:00'],
        appointment: null,
        reply: null,
        answers: [],
      },
      notes: [],
      summaryMessage: null,
    };
    const input = phoneCallTool.inputSchema.parse({
      to: '+49301234567',
      language: 'de',
      purpose: 'availability',
      goal: 'x',
      date: '2026-11-13',
    });
    expect(outcomeText('de', input, outcome)).toBe(
      'Frei am Freitag, 13. November: 9:30 Uhr und 14:00 Uhr.',
    );
    expect(outcomeText('en', input, outcome)).toBe(
      'Free on Friday, November 13: 9:30 AM and 2:00 PM.',
    );
  });
});
