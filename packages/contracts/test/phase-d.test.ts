/**
 * Phase D contracts (docs/architecture/phase-d.md §6): voice conversation and the phone
 * agent. Additive and backward compatible — every payload of an older server or client still
 * decodes — plus the shapes the stage-2 owners build against, and the separate, unauthenticated
 * telephony webhook route group.
 */
import { describe, expect, it } from 'vitest';
import {
  AccountEventType,
  ApiErrorReason,
  ApprovalDetails,
  AssistantStatus,
  CALL_LIMITS,
  CallSession,
  CallSummary,
  ConfirmPhoneVerificationRequest,
  DEFAULT_PREFERENCES,
  DoNotCallEntry,
  E164PhoneNumber,
  EVIDENCE_MEDIA_TYPE,
  EvidenceArtifact,
  EvidenceCode,
  Me,
  MissingInfo,
  PhoneCallInput,
  PhoneVerification,
  PhoneVerificationState,
  PolicyReason,
  Preferences,
  ServerMessageKey,
  TaskSummary,
  SkillUnavailableReason,
  TELEPHONY_WEBHOOK_LIMITS,
  TELEPHONY_WEBHOOK_PREFIX,
  TaskDetail,
  TaskErrorReason,
  ToolId,
  UpdateMeRequest,
  VOICE_LIMITS,
  VerificationCheckKey,
  VoiceSession,
  VoiceSessionEnd,
  VoiceSessionStart,
  WebhookUrlToken,
  routes,
  telephonyWebhookRoutes,
  type RouteDef,
  type TelephonyWebhookDef,
} from '../src/index';

const ID = '00000000-0000-4000-8000-000000000001';
const ID2 = '00000000-0000-4000-8000-000000000002';
const AT = '2026-11-04T10:00:00.000Z';
const CALL_SID = `CA${'a'.repeat(32)}`;
const ACCOUNT_SID = `AC${'b'.repeat(32)}`;
const TOKEN = 'A'.repeat(43);

const SCRIPT = {
  opening:
    'Hello, this is JARVIS, an AI assistant calling on behalf of Alex Doe. I am calling to ask whether you have an appointment free on Tuesday, 10 November.',
  recordingQuestion: null,
  message: null,
  questions: ['Which times do you have free that day?'],
  closing: 'Thank you, I will pass this on to Alex Doe. Goodbye.',
  voicemailMessage: null,
};

const CALL_DETAILS = {
  kind: 'phone_call',
  to: '+493012345678',
  toDisplay: '+49 30 12345678',
  country: 'DE',
  calleeName: 'my dentist',
  onBehalfOf: 'Alex Doe',
  callerId: '+4930999999',
  language: 'en',
  purpose: 'availability',
  goal: 'Ask whether they have an appointment free on Tuesday',
  script: SCRIPT,
  dialog: 'scripted',
  date: '2026-11-10',
  window: null,
  shareInfo: [{ label: 'Name', value: 'Alex Doe' }],
  maxDurationSeconds: 300,
  allowedHours: { start: '08:00', end: '20:00', timeZone: 'Europe/Berlin' },
  recording: 'off',
  voicemail: 'hang_up',
  transfer: { allowed: false, to: null },
  binding: false,
  costEstimate: null,
} as const;

const SESSION = {
  id: ID,
  taskId: ID,
  stepId: ID2,
  attempt: 1,
  to: '+493012345678',
  toDisplay: '+49 30 12345678',
  calleeName: 'my dentist',
  language: 'en',
  purpose: 'availability',
  status: 'ended',
  result: 'completed',
  outcome: {
    result: 'completed',
    goalReached: true,
    details: {
      date: '2026-11-10',
      times: ['09:30', '14:00'],
      appointment: null,
      reply: null,
      answers: [],
    },
    notes: [],
    summaryMessage: { key: 'result.callCompleted', params: { who: 'my dentist' } },
  },
  provider: 'twilio',
  providerCallSid: CALL_SID,
  answeredBy: 'human',
  aiDisclosedAt: AT,
  recording: { mode: 'off', consent: 'not_asked', consentAt: null, artifactId: null },
  transfer: { status: 'none', at: null },
  timeline: [
    { status: 'dialing', providerStatus: 'queued', sequence: null, at: AT },
    { status: 'ringing', providerStatus: 'ringing', sequence: 1, at: AT },
    { status: 'in_progress', providerStatus: 'in-progress', sequence: 2, at: AT },
    { status: 'ended', providerStatus: 'completed', sequence: 3, at: AT },
  ],
  durationSeconds: 74,
  maxDurationSeconds: 300,
  costEstimate: { amountMicro: 250_000, currency: 'USD' },
  price: { amountMicro: 26_000, currency: 'USD' },
  failureReason: null,
  turns: [
    {
      id: ID,
      sequence: 0,
      speaker: 'agent',
      kind: 'disclosure',
      text: SCRIPT.opening,
      language: 'en',
      confidence: null,
      flagged: false,
      at: AT,
    },
    {
      id: ID2,
      sequence: 1,
      speaker: 'callee',
      kind: 'answer',
      text: 'We have 9:30 and 2 pm.',
      language: 'en',
      confidence: 0.91,
      flagged: false,
      at: AT,
    },
  ],
  dialedAt: AT,
  answeredAt: AT,
  endedAt: AT,
  createdAt: AT,
  updatedAt: AT,
};

describe('Phase D: enums', () => {
  it('adds phone.call and keeps every earlier tool', () => {
    expect(ToolId.options).toContain('phone.call');
    expect(ToolId.options.at(-1)).toBe('phone.call');
  });

  it('every policy deny reason of calls is a task error reason clients explain', () => {
    for (const r of [
      'DO_NOT_CALL',
      'CALL_OUTSIDE_HOURS',
      'CALL_LIMIT',
      'CALL_DESTINATION_BLOCKED',
      'TELEPHONY_NOT_CONFIGURED',
    ] as const) {
      expect(PolicyReason.options).toContain(r);
      expect(TaskErrorReason.options).toContain(r);
    }
    for (const r of ['PHONE_CALL', 'CALL_RECORDING', 'CALL_PERSONAL_INFO'] as const)
      expect(PolicyReason.options).toContain(r);
  });

  it('names every unsuccessful call outcome precisely (scenario 4)', () => {
    for (const r of [
      'CALL_BUSY',
      'CALL_NO_ANSWER',
      'CALL_FAILED',
      'CALL_VOICEMAIL',
      'CALL_HUNG_UP',
      'CALL_DECLINED',
      'CALL_DURATION_LIMIT',
      'RECORDING_CONSENT_DECLINED',
      'CALL_STATE_UNKNOWN',
      'NUMBER_NOT_LITERAL',
      'PHONE_NUMBER_INVALID',
    ] as const)
      expect(TaskErrorReason.options).toContain(r);
  });

  it('adds the server sentences, questions, evidence and checks of calls', () => {
    expect(ServerMessageKey.options).toEqual(
      expect.arrayContaining([
        'plan.call',
        'objective.call',
        'step.call',
        'approval.call',
        'result.callCompleted',
        'result.callAnswered',
        'result.callTransferred',
        'question.phoneNumber',
        'question.callGoal',
      ]),
    );
    expect(MissingInfo.options).toEqual(expect.arrayContaining(['phone_number', 'call_goal']));
    expect(EvidenceCode.options).toEqual(
      expect.arrayContaining(['CALL_PLACED', 'CALL_ENDED', 'AI_DISCLOSED', 'RECORDING_CONSENT']),
    );
    expect(VerificationCheckKey.options).toEqual(
      expect.arrayContaining(['callConnected', 'aiDisclosed', 'consentRespected']),
    );
    expect(SkillUnavailableReason.options).toContain('TELEPHONY_NOT_CONFIGURED');
    expect(ApiErrorReason.options).toEqual(
      expect.arrayContaining(['PHONE_NUMBER_INVALID', 'WEBHOOK_SIGNATURE_INVALID']),
    );
    expect(AccountEventType.options).toEqual(
      expect.arrayContaining(['call.status_changed', 'call.turn', 'phone_verification.changed']),
    );
  });

  it('a call recording is an evidence file of its own media type', () => {
    expect(EVIDENCE_MEDIA_TYPE.recording).toBe('audio/mpeg');
    expect(routes.downloadEvidence.download.mediaTypes).toContain('audio/mpeg');
  });
});

describe('Phase D: phone numbers', () => {
  it('accepts E.164 only (country code, no spaces, no local formats, no short codes)', () => {
    for (const ok of ['+493012345678', '+14155550123', '+966112345678'])
      expect(E164PhoneNumber.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['030 1234567', '0301234567', '+49 30 1234567', '112', '+0123456789', '+1'])
      expect(E164PhoneNumber.safeParse(bad).success, bad).toBe(false);
  });

  it('the profile number is optional for older payloads and can be removed with null', () => {
    const me = {
      id: ID,
      email: 'a@example.com',
      displayName: 'A',
      locale: 'en',
      timeZone: 'UTC',
      theme: 'system',
      roles: ['owner'],
      tenant: { id: ID, name: 'T' },
      preferences: DEFAULT_PREFERENCES,
      createdAt: AT,
    };
    expect(Me.parse(me).phoneNumber).toBeUndefined();
    expect(
      Me.parse({ ...me, phoneNumber: '+493012345678', phoneNumberVerifiedAt: AT })
        .phoneNumberVerifiedAt,
    ).toBe(AT);
    expect(UpdateMeRequest.parse({ phoneNumber: null })).toEqual({ phoneNumber: null });
    expect(UpdateMeRequest.safeParse({ phoneNumber: '030 1234' }).success).toBe(false);
  });

  it('a verification code is exactly the digits read out', () => {
    expect(ConfirmPhoneVerificationRequest.parse({ code: ' 123456 ' }).code).toBe('123456');
    expect(ConfirmPhoneVerificationRequest.safeParse({ code: '12345' }).success).toBe(false);
    expect(ConfirmPhoneVerificationRequest.safeParse({ code: '12345a' }).success).toBe(false);
    expect(
      PhoneVerification.parse({
        id: ID,
        status: 'pending',
        number: '+49 30 ••• •• 78',
        attemptsLeft: CALL_LIMITS.verificationMaxAttempts,
        expiresAt: AT,
        createdAt: AT,
      }).status,
    ).toBe('pending');
  });
});

describe('Phase D: voice conversation preferences and sessions', () => {
  it('stored preferences without the Phase D voice fields decode with defaults', () => {
    const old = {
      ...DEFAULT_PREFERENCES,
      voice: { speakResponses: true, recognitionLocale: 'de-DE' },
    };
    const v = Preferences.parse(old).voice;
    expect(v).toEqual({
      speakResponses: true,
      recognitionLocale: 'de-DE',
      conversationMode: false,
      speakingRate: 1,
      endOfSpeechSilenceMs: VOICE_LIMITS.endOfSpeechSilenceMs.default,
      voiceNames: { en: null, de: null, ar: null },
    });
    expect(Preferences.parse(DEFAULT_PREFERENCES)).toEqual(DEFAULT_PREFERENCES);
  });

  it('a PATCH of one voice field never resets the others to their defaults', () => {
    const patch = UpdateMeRequest.parse({
      preferences: { voice: { speakingRate: 1.25, voiceNames: { de: 'Anna' } } },
    });
    expect(patch.preferences?.voice).toEqual({ speakingRate: 1.25, voiceNames: { de: 'Anna' } });
    expect(UpdateMeRequest.safeParse({ preferences: { voice: { speakingRate: 3 } } }).success).toBe(
      false,
    );
    expect(
      UpdateMeRequest.safeParse({ preferences: { voice: { endOfSpeechSilenceMs: 100 } } }).success,
    ).toBe(false);
  });

  it('voice sessions default to dictation; conversations carry counters only (no content)', () => {
    expect(VoiceSessionStart.parse({ locale: 'en-US', engine: 'browser_speech' }).mode).toBe(
      'dictation',
    );
    const end = VoiceSessionEnd.parse({
      outcome: 'ended',
      transcriptChars: 120,
      turns: 3,
      bargeIns: 1,
      reconnects: 0,
      endReason: 'voice_command',
    });
    expect(end.turns).toBe(3);
    expect(Object.keys(VoiceSessionEnd.shape)).not.toContain('transcript');
    expect(VoiceSession.parse({ id: ID, startedAt: AT, endedAt: null }).mode).toBeUndefined();
  });

  it('has stop phrases in every language, already normalised (lower case, trimmed)', () => {
    for (const [lang, phrases] of Object.entries(VOICE_LIMITS.stopPhrases)) {
      expect(phrases.length, lang).toBeGreaterThan(0);
      for (const p of phrases) expect(p, lang).toBe(p.trim().toLocaleLowerCase(lang));
    }
    expect(VOICE_LIMITS.stopPhrases.de).toContain('stopp');
    expect(VOICE_LIMITS.stopPhrases.ar).toContain('توقف');
  });
});

describe('Phase D: phone.call input, approval and call records', () => {
  it('fills safe defaults: no recording, hang up on voicemail, no transfer, no script yet', () => {
    const input = PhoneCallInput.parse({
      to: '+493012345678',
      language: 'de',
      purpose: 'message',
      goal: 'Tell them I am 10 minutes late',
      message: 'Ich komme etwa zehn Minuten später.',
    });
    expect(input).toMatchObject({
      recording: 'off',
      voicemail: 'hang_up',
      allowTransfer: false,
      shareInfo: [],
      questions: [],
      maxDurationSeconds: 300,
      dialog: 'scripted',
      script: null,
      calleeName: null,
    });
  });

  it('bounds what one call may ask, share and last', () => {
    const base = { to: '+493012345678', language: 'en', purpose: 'questions', goal: 'Ask' };
    const q = (n: number) => Array.from({ length: n }, (_, i) => `Question ${i + 1}?`);
    expect(
      PhoneCallInput.safeParse({ ...base, questions: q(CALL_LIMITS.maxQuestions) }).success,
    ).toBe(true);
    expect(
      PhoneCallInput.safeParse({ ...base, questions: q(CALL_LIMITS.maxQuestions + 1) }).success,
    ).toBe(false);
    expect(
      PhoneCallInput.safeParse({ ...base, maxDurationSeconds: CALL_LIMITS.maxDurationSeconds + 1 })
        .success,
    ).toBe(false);
    expect(PhoneCallInput.safeParse({ ...base, to: '0301234567' }).success).toBe(false);
  });

  it('the approval shows everything the user must see before a call', () => {
    const parsed = ApprovalDetails.parse(CALL_DETAILS);
    expect(parsed.kind).toBe('phone_call');
    const variant = ApprovalDetails.options.find((o) => o.shape.kind.value === 'phone_call')!;
    for (const field of [
      'to',
      'toDisplay',
      'calleeName',
      'onBehalfOf',
      'callerId',
      'language',
      'purpose',
      'goal',
      'script',
      'dialog',
      'shareInfo',
      'maxDurationSeconds',
      'allowedHours',
      'recording',
      'voicemail',
      'transfer',
      'binding',
      'costEstimate',
    ])
      expect(Object.keys(variant.shape), field).toContain(field);
  });

  it('call records decode with their structured outcome, timeline and turns', () => {
    const s = CallSession.parse(SESSION);
    expect(s.outcome?.details.times).toEqual(['09:30', '14:00']);
    expect(Object.keys(CallSummary.shape)).not.toContain('turns');
    expect(Object.keys(CallSummary.shape)).not.toContain('timeline');
    const { turns: _t, timeline: _l, ...summary } = SESSION;
    expect(CallSummary.parse(summary).providerCallSid).toBe(CALL_SID);
  });

  it('tasks of older servers have no calls; evidence files have no call id', () => {
    expect(TaskDetail.shape.calls.safeParse(undefined).success).toBe(true);
    expect(
      EvidenceArtifact.parse({
        id: ID,
        kind: 'screenshot',
        mediaType: 'image/png',
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
        pageUrl: null,
        taskId: ID,
        browserSessionId: ID,
        downloadPath: `/v1/evidence/${ID}/content`,
        createdAt: AT,
      }).callSessionId,
    ).toBeUndefined();
    expect(AssistantStatus.shape.capabilities.shape.phoneCalls.safeParse(undefined).success).toBe(
      true,
    );
  });

  it('do-not-call entries never carry the full number', () => {
    const e = DoNotCallEntry.parse({
      id: ID,
      number: '+49 30 ••• •• 78',
      country: 'DE',
      source: 'callee_request',
      callId: ID2,
      createdAt: AT,
    });
    expect(Object.keys(e)).not.toContain('numberHash');
    // Additive: the task of that call (older servers omit it).
    expect(DoNotCallEntry.parse({ ...e, taskId: ID }).taskId).toBe(ID);
  });

  it('additive Phase D fields of existing read models decode from older payloads', () => {
    expect(TaskSummary.shape.language.safeParse(undefined).success).toBe(true);
    expect(TaskSummary.shape.language.parse('de')).toBe('de');
    expect(CallSummary.shape.taskTitle.safeParse(undefined).success).toBe(true);
  });
});

describe('Phase D: user routes', () => {
  const PHASE_D = [
    'listCalls',
    'getCall',
    'listDoNotCall',
    'deleteDoNotCall',
    'getPhoneVerification',
    'startPhoneVerification',
    'confirmPhoneVerification',
  ] as const;

  it('adds seven routes, all for signed-in users', () => {
    for (const name of PHASE_D) expect((routes[name] as RouteDef).auth, name).toBe('user');
  });

  it('the live verification can be read again (a client that left or reloaded resumes)', () => {
    expect(routes.getPhoneVerification).toMatchObject({
      method: 'GET',
      path: routes.startPhoneVerification.path,
    });
    expect(PhoneVerificationState.parse({ verification: null })).toEqual({ verification: null });
  });

  it('calls are records of what the agent did: no HTTP route places a call', () => {
    for (const [name, r] of Object.entries(routes) as [string, RouteDef][]) {
      if (r.path.startsWith('/v1/calls')) expect(r.method, name).toBe('GET');
      expect(r.path.startsWith(TELEPHONY_WEBHOOK_PREFIX), name).toBe(false);
    }
  });
});

describe('Phase D: telephony webhook route group', () => {
  const defs = Object.entries(telephonyWebhookRoutes) as [string, TelephonyWebhookDef][];

  it('is separate from the user API: POST-only, under its own prefix, never in `routes`', () => {
    const apiPaths = new Set(Object.values(routes).map((r) => `${r.method} ${r.path}`));
    const seen = new Set<string>();
    for (const [name, d] of defs) {
      expect(d.method, name).toBe('POST');
      expect(d.path.startsWith(TELEPHONY_WEBHOOK_PREFIX), name).toBe(true);
      expect(apiPaths.has(`${d.method} ${d.path}`), name).toBe(false);
      expect(seen.has(d.path), name).toBe(false);
      seen.add(d.path);
      expect(name in routes, name).toBe(false);
    }
  });

  it('every webhook URL carries the call’s token; a gather answer also its turn', () => {
    for (const [name, d] of defs) {
      expect(Object.keys(d.query.shape), name).toContain('t');
      expect(d.query.safeParse({ t: 'short' }).success, name).toBe(false);
    }
    expect(Object.keys(telephonyWebhookRoutes.twilioCallGather.query.shape)).toContain('n');
    expect(WebhookUrlToken.safeParse(TOKEN).success).toBe(true);
    expect(TELEPHONY_WEBHOOK_LIMITS.urlTokenBytes).toBe(32);
  });

  it('form bodies need the provider ids and keep unknown parameters (they are signed)', () => {
    const form = telephonyWebhookRoutes.twilioCallStatus.form;
    expect(form.safeParse({ CallStatus: 'ringing' }).success).toBe(false);
    const parsed = form.parse({
      CallSid: CALL_SID,
      AccountSid: ACCOUNT_SID,
      CallStatus: 'completed',
      CallDuration: '74',
      SequenceNumber: '3',
      Timestamp: 'Wed, 04 Nov 2026 10:00:00 +0000',
      NewTwilioParameter: 'x',
    }) as Record<string, unknown>;
    expect(parsed.NewTwilioParameter).toBe('x');
    expect(
      telephonyWebhookRoutes.twilioCallGather.form.parse({
        CallSid: CALL_SID,
        AccountSid: ACCOUNT_SID,
      }),
    ).toMatchObject({ CallSid: CALL_SID });
  });

  it('every call and verification event has a route', () => {
    expect(defs.filter(([, d]) => d.target === 'call').map(([n]) => n)).toEqual([
      'twilioCallVoice',
      'twilioCallGather',
      'twilioCallStatus',
      'twilioCallAmd',
      'twilioCallDial',
      'twilioCallWhisper',
      'twilioCallRecording',
    ]);
    expect(defs.filter(([, d]) => d.target === 'verification')).toHaveLength(2);
  });

  it('the transfer whisper names the call JARVIS placed as its parent (the owner’s leg is a child)', () => {
    const form = telephonyWebhookRoutes.twilioCallWhisper.form;
    expect(form.safeParse({ CallSid: CALL_SID, AccountSid: ACCOUNT_SID }).success).toBe(false);
    expect(
      form.parse({ CallSid: CALL_SID, AccountSid: ACCOUNT_SID, ParentCallSid: CALL_SID }),
    ).toMatchObject({ ParentCallSid: CALL_SID });
    expect(telephonyWebhookRoutes.twilioCallWhisper.responds).toBe('twiml');
  });
});

describe('Phase D: limits', () => {
  it('are internally consistent', () => {
    expect(CALL_LIMITS.minDurationSeconds).toBeLessThan(CALL_LIMITS.maxDurationSeconds);
    expect(PhoneCallInput.shape.maxDurationSeconds.parse(undefined)).toBeLessThanOrEqual(
      CALL_LIMITS.maxDurationSeconds,
    );
    expect(CALL_LIMITS.defaultAllowedHours.start < CALL_LIMITS.defaultAllowedHours.end).toBe(true);
    expect(VOICE_LIMITS.speakingRate.min).toBeLessThan(VOICE_LIMITS.speakingRate.max);
    expect(VOICE_LIMITS.endOfSpeechSilenceMs.default).toBeGreaterThanOrEqual(
      VOICE_LIMITS.endOfSpeechSilenceMs.min,
    );
    expect(CALL_LIMITS.verificationCodeLength).toBe(6);
  });
});
