/**
 * Phase D view logic (pure): what a voice conversation says about a task, the overlay's honest
 * states, the call view model, phone-number input, Phase D evidence and stream invalidation.
 */
import type { CallSession, TaskDetail } from '@jarvis/contracts';
import { CallResult, CallStatus, ServerMessageKey, TaskErrorReason } from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import { approvalSentence } from '@/components/approvals/sentence';
import { deriveAssistantPresence } from '@/components/presence/model';
import { displayOf } from '@/components/voice/display';
import {
  classifySubmitError,
  pendingApprovalId,
  plain,
  replyLine,
  taskView,
} from '@/components/voice/replies';
import {
  attemptsNewestFirst,
  calleeLabel,
  callPill,
  collectedFacts,
  isE164,
  isLive,
  normalizePhoneInput,
} from '@/features/calls/model';
import { hasNextStep } from '@/features/tasks/phase-c/NextStep';
import { parseEvidence } from '@/features/tasks/model';
import { createFormatters } from '@/i18n/format';
import { FSI, PDI } from '@/i18n/icu';
import { catalogs } from '@/i18n/messages';
import { renderServerMessage } from '@/i18n/server-message';
import { createTranslator, lookup, stripIsolates } from '@/i18n/translate';
import { ApiError } from '@/lib/api/client';
import { queriesToInvalidate, RECONNECT_INVALIDATIONS } from '@/lib/events/invalidation';
import { qk } from '@/lib/api/query-keys';

const en = { t: createTranslator('en', catalogs.en), messages: catalogs.en };
const de = { t: createTranslator('de', catalogs.de), messages: catalogs.de };
const ar = { t: createTranslator('ar', catalogs.ar), messages: catalogs.ar };
const LANGS = { ui: 'en-US', request: 'en-US' };

function task(patch: Partial<TaskDetail>): TaskDetail {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Answer',
    titleMessage: null,
    request: 'What is new?',
    status: 'RUNNING',
    riskLevel: 'LOW',
    source: 'voice',
    progress: { completed: 0, total: 1 },
    pendingApprovalId: null,
    pendingApproval: null,
    resultSummary: null,
    resultSummaryMessage: null,
    error: null,
    createdAt: '2026-11-04T10:00:00Z',
    updatedAt: '2026-11-04T10:00:00Z',
    completedAt: null,
    conversationId: '22222222-2222-4222-8222-222222222222',
    outcome: null,
    question: null,
    objective: null,
    planner: null,
    answer: null,
    steps: [],
    approvals: [],
    events: [],
    cost: { estimatedMicroUsd: 0, actualMicroUsd: 0 },
    evidence: [],
    canCancel: true,
    canRetry: false,
    startedAt: null,
    ...patch,
  } as TaskDetail;
}

describe('what a voice conversation says about a task', () => {
  it('nothing while the task works; the answer is spoken from the answer itself', () => {
    expect(replyLine(en, task({ status: 'RUNNING' }), LANGS)).toBeNull();
    expect(replyLine(en, task({ status: 'COMPLETED', answer: 'Hi.' }), LANGS)).toBeNull();
    const view = taskView(en, task({ status: 'COMPLETED', answer: 'Hi.' }), LANGS);
    expect(view.answer).toBe('Hi.');
    // A streamed answer counts only once the task is over.
    expect(taskView(en, task({ status: 'RUNNING', answer: 'Hi' }), LANGS).answer).toBeNull();
  });

  it('the result line in the viewer’s language, without isolation marks', () => {
    const line = replyLine(
      de,
      task({
        status: 'COMPLETED',
        resultSummary: 'Called my dentist; the call reached its goal.',
        resultSummaryMessage: {
          key: 'result.callCompleted',
          params: { who: 'meine Zahnarztpraxis' },
        },
      }),
      { ui: 'de-DE', request: 'en-US' },
    );
    expect(line).toEqual({
      text: stripIsolates(
        renderServerMessage(de, {
          key: 'result.callCompleted',
          params: { who: 'meine Zahnarztpraxis' },
        })!,
      ),
      lang: 'de-DE',
      kind: 'result',
    });
    expect(line!.text).toContain('meine Zahnarztpraxis');
    expect(line!.text).not.toMatch(/[⁦-⁩]/);
  });

  it('model text stays in the request’s language; a question is asked', () => {
    expect(
      replyLine(en, task({ status: 'COMPLETED', resultSummary: 'Free at 9:30.' }), {
        ui: 'en-US',
        request: 'de-DE',
      }),
    ).toEqual({ text: 'Free at 9:30.', lang: 'de-DE', kind: 'result' });
    expect(
      replyLine(
        en,
        task({
          status: 'COMPLETED',
          question: {
            text: 'Which number?',
            message: { key: 'question.phoneNumber', params: {} },
            missing: ['phone_number'],
          },
        }),
        LANGS,
      ),
    ).toMatchObject({ kind: 'question', lang: 'en-US' });
  });

  it('a failure says what and why; declined and expired are said too', () => {
    const failed = replyLine(
      en,
      task({
        status: 'FAILED',
        error: { code: 'TOOL_FAILED', message: 'x', retryable: true, reason: 'CALL_BUSY' },
      }),
      LANGS,
    );
    expect(failed).toMatchObject({ kind: 'error', lang: 'en-US' });
    expect(failed!.text).toContain('The line was busy.');
    expect(replyLine(en, task({ status: 'EXPIRED' }), LANGS)?.kind).toBe('error');
    expect(replyLine(en, task({ status: 'CANCELLED' }), LANGS)?.kind).toBe('result');
  });

  it('finds the pending approval only while the task waits for it', () => {
    const approvals = [{ id: 'a1', status: 'PENDING' }] as unknown as TaskDetail['approvals'];
    expect(pendingApprovalId(task({ status: 'AWAITING_APPROVAL', approvals }))).toBe('a1');
    expect(pendingApprovalId(task({ status: 'RUNNING', approvals }))).toBeNull();
  });

  it('retries only what may succeed later; CONVERSATION_BUSY is "still busy"', () => {
    expect(classifySubmitError(new ApiError('NETWORK', 'x', 0))).toBe('network');
    expect(classifySubmitError(new ApiError('INTERNAL', 'x', 500))).toBe('network');
    expect(classifySubmitError(new ApiError('RATE_LIMITED', 'x', 429))).toBe('network');
    expect(
      classifySubmitError(
        new ApiError('INVALID_STATE', 'x', 409, undefined, { reason: 'CONVERSATION_BUSY' }),
      ),
    ).toBe('busy');
    expect(classifySubmitError(new ApiError('VALIDATION_FAILED', 'x', 400))).toBe('fatal');
    expect(classifySubmitError(new Error('x'))).toBe('fatal');
  });
});

describe('honest overlay states', () => {
  it('maps the turn and the microphone to one state', () => {
    const d = (turn: string, mic = 'on', streamDown = false) =>
      displayOf({ turn, mic, streamDown } as Parameters<typeof displayOf>[0]);
    expect(d('ready')).toBe('listening');
    expect(d('ready', 'muted')).toBe('paused');
    expect(d('ready', 'starting')).toBe('requesting');
    expect(d('ready', 'denied')).toBe('denied');
    expect(d('ready', 'unsupported')).toBe('unsupported');
    expect(d('submitting')).toBe('sending');
    expect(d('retrying')).toBe('retrying');
    expect(d('thinking')).toBe('thinking');
    expect(d('thinking', 'on', true)).toBe('reconnecting');
    expect(d('speaking')).toBe('speaking');
    expect(d('awaiting_approval')).toBe('awaiting');
    expect(d('failed')).toBe('failed');
    expect(d('ended')).toBe('ended');
  });

  it('every state has copy in every language', () => {
    for (const catalog of [catalogs.en, catalogs.de, catalogs.ar]) {
      for (const state of [
        'requesting',
        'listening',
        'paused',
        'sending',
        'retrying',
        'thinking',
        'reconnecting',
        'speaking',
        'awaiting',
        'failed',
        'unsupported',
        'denied',
        'noMicrophone',
        'micError',
        'ended',
      ]) {
        expect(lookup(catalog, `voice.conversation.states.${state}`), state).toBeTruthy();
      }
    }
  });

  it('the app-wide Presence says "speaking" only while JARVIS speaks', () => {
    const base = {
      online: true,
      stream: 'open' as const,
      workerHealthy: true,
      activeTasks: [],
      pendingApprovals: 0,
      flash: null,
      listening: true,
    };
    expect(deriveAssistantPresence({ ...base, speaking: true }).state).toBe('speaking');
    expect(deriveAssistantPresence({ ...base, speaking: false }).state).toBe('listening');
    // Connectivity still comes first.
    expect(deriveAssistantPresence({ ...base, online: false, speaking: true }).state).toBe(
      'offline',
    );
  });
});

/* ------------------------------------------------------------------ calls */

function call(patch: Partial<CallSession>): CallSession {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    taskId: '11111111-1111-4111-8111-111111111111',
    stepId: '44444444-4444-4444-8444-444444444444',
    attempt: 1,
    to: '+49301234567',
    toDisplay: '+49 30 1234567',
    calleeName: null,
    language: 'de',
    purpose: 'availability',
    status: 'ended',
    result: 'busy',
    outcome: null,
    provider: 'twilio',
    providerCallSid: 'CA1',
    answeredBy: null,
    aiDisclosedAt: null,
    recording: { mode: 'off', consent: 'not_asked', consentAt: null, artifactId: null },
    transfer: { status: 'none', at: null },
    timeline: [],
    durationSeconds: 0,
    maxDurationSeconds: 300,
    costEstimate: null,
    price: null,
    failureReason: 'CALL_BUSY',
    turns: [],
    dialedAt: null,
    answeredAt: null,
    endedAt: null,
    createdAt: '2026-11-04T10:00:00Z',
    updatedAt: '2026-11-04T10:00:00Z',
    ...patch,
  };
}

describe('call view model', () => {
  it('has a label for every status and result, in every language', () => {
    for (const catalog of [catalogs.en, catalogs.de, catalogs.ar]) {
      for (const status of CallStatus.options) {
        const pill = callPill({ status, result: null });
        expect(lookup(catalog, pill.key), status).toBeTruthy();
      }
      for (const result of CallResult.options) {
        const pill = callPill({ status: 'ended', result });
        expect(lookup(catalog, pill.key), result).toBeTruthy();
      }
    }
    expect(callPill({ status: 'ended', result: 'completed' }).tone).toBe('success');
    expect(callPill({ status: 'ended', result: 'failed' }).tone).toBe('danger');
    expect(callPill({ status: 'in_progress', result: null }).tone).toBe('accent');
  });

  it('knows live calls, names the callee, orders attempts newest first', () => {
    expect(isLive({ status: 'ringing' })).toBe(true);
    expect(isLive({ status: 'ended' })).toBe(false);
    expect(calleeLabel({ calleeName: ' ', toDisplay: '+49 30 1234567' })).toBe('+49 30 1234567');
    expect(calleeLabel({ calleeName: 'Dr. Weber', toDisplay: '+49 30 1234567' })).toBe('Dr. Weber');
    const ordered = attemptsNewestFirst([
      call({ attempt: 1 }),
      call({ attempt: 3 }),
      call({ attempt: 2 }),
    ]);
    expect(ordered.map((c) => c.attempt)).toEqual([3, 2, 1]);
  });

  it('shows only what was collected', () => {
    expect(
      collectedFacts({ date: null, times: [], appointment: null, reply: null, answers: [] }),
    ).toEqual([]);
    expect(
      collectedFacts({
        date: '2026-11-06',
        times: ['11:15', '09:30'],
        appointment: null,
        reply: 'See you',
        answers: [{ question: 'Parking?', answer: null }],
      }).map((f) => f.kind),
    ).toEqual(['date', 'times', 'reply', 'answers']);
    const appt = collectedFacts({
      date: '2026-11-06',
      times: ['09:30'],
      appointment: { date: '2026-11-06', time: '09:30', name: null, reference: 'A-17' },
      reply: null,
      answers: [],
    });
    expect(appt).toEqual([
      { kind: 'appointment', date: '2026-11-06', time: '09:30', name: null, reference: 'A-17' },
    ]);
  });

  it('every call failure has its next step; the policy ones say what to do', () => {
    for (const reason of [
      'CALL_BUSY',
      'CALL_NO_ANSWER',
      'CALL_VOICEMAIL',
      'CALL_HUNG_UP',
      'CALL_FAILED',
      'CALL_DURATION_LIMIT',
    ] as const) {
      expect(hasNextStep({ reason }), reason).toBe('callRetry');
    }
    expect(hasNextStep({ reason: 'CALL_STATE_UNKNOWN' })).toBe('callUnknown');
    expect(hasNextStep({ reason: 'DO_NOT_CALL' })).toBe('doNotCall');
    expect(hasNextStep({ reason: 'CALL_OUTSIDE_HOURS' })).toBe('callHours');
    expect(hasNextStep({ reason: 'CALL_DECLINED' })).toBe('callDeclined');
    expect(hasNextStep({ reason: 'RECORDING_CONSENT_DECLINED' })).toBe('callRecording');
  });

  it('every Phase D reason, server sentence and evidence code has copy in every language', () => {
    const reasons = TaskErrorReason.options.filter(
      (r) =>
        r.startsWith('CALL_') ||
        [
          'DO_NOT_CALL',
          'RECORDING_CONSENT_DECLINED',
          'PHONE_NUMBER_INVALID',
          'NUMBER_NOT_LITERAL',
          'TELEPHONY_NOT_CONFIGURED',
        ].includes(r),
    );
    for (const i18n of [en, de, ar]) {
      for (const r of reasons) expect(lookup(i18n.messages, `errors.reasons.${r}`), r).toBeTruthy();
      for (const key of ServerMessageKey.options.filter(
        (k) => k.includes('call') || k.includes('Call') || k.startsWith('question.phone'),
      )) {
        expect(lookup(i18n.messages, `tasks.server.${key}`), key).toBeTruthy();
      }
    }
    for (const code of [
      'CALL_PLACED',
      'CALL_ENDED',
      'AI_DISCLOSED',
      'RECORDING_CONSENT',
      'CALL_TRANSCRIPT',
      'CALL_RECORDING',
      'CALL_TRANSFER',
      'DO_NOT_CALL_RECORDED',
    ] as const) {
      const view = parseEvidence({
        kind: 'record',
        label: '',
        value: '',
        at: '2026-11-04T10:00:00Z',
        code,
        params: {},
      });
      expect(view.kind, code).toBe('phaseC');
    }
  });
});

describe('phone numbers in sentences and fields', () => {
  it('a number is one left-to-right run, even in Arabic', () => {
    const rendered = renderServerMessage(ar, {
      key: 'approval.call',
      params: { who: 'عيادة', number: '+49 30 1234567' },
    })!;
    expect(rendered).toContain(`${FSI}⁦+49 30 1234567⁩${PDI}`);
    // The approval reads the number as written on it, not the E.164 form.
    const sentence = approvalSentence(
      {
        summary: 'Call',
        summaryMessage: {
          key: 'approval.call',
          params: { who: 'my dentist', number: '+49301234567' },
        },
        details: { kind: 'phone_call', toDisplay: '+49 30 1234567' } as never,
      },
      { t: en.t, f: createFormatters('en'), messages: catalogs.en },
    );
    expect(stripIsolates(sentence.text)).toBe(
      'Call my dentist (+49 30 1234567) and speak for you as an AI assistant.',
    );
  });

  it('normalises what people type into E.164', () => {
    expect(normalizePhoneInput('0049 (170) 123-4589')).toBe('+491701234589');
    expect(normalizePhoneInput('+49 30 1234567')).toBe('+49301234567');
    expect(normalizePhoneInput('٠٠٩٦٦٥٠١٢٣٤٥٦٧')).toBe('+966501234567');
    expect(isE164('+49301234567')).toBe(true);
    expect(isE164('030 1234567')).toBe(false);
    expect(isE164('+0123')).toBe(false);
  });
});

describe('stream invalidation of calls', () => {
  const callId = '33333333-3333-4333-8333-333333333333';
  it('a turn refreshes the task and the call; a status change also the list', () => {
    expect(
      queriesToInvalidate({ type: 'call.turn', taskId: 't', data: { callId, sequence: 3 } }),
    ).toEqual([qk.tasks.detail('t'), qk.calls.detail(callId)]);
    const status = queriesToInvalidate({
      type: 'call.status_changed',
      taskId: 't',
      data: { callId, status: 'ended', result: 'completed' },
    });
    expect(status).toEqual(
      expect.arrayContaining([
        qk.tasks.detail('t'),
        qk.calls.detail(callId),
        qk.calls.list,
        qk.doNotCall,
      ]),
    );
    expect(
      queriesToInvalidate({
        type: 'call.status_changed',
        taskId: 't',
        data: { callId, status: 'ringing' },
      }),
    ).not.toContainEqual(qk.doNotCall);
    expect(queriesToInvalidate({ type: 'phone_verification.changed', taskId: null })).toEqual([
      qk.me,
      qk.phoneVerification,
    ]);
    expect(RECONNECT_INVALIDATIONS).toEqual(expect.arrayContaining([qk.calls.all, qk.doNotCall]));
  });
});

describe('spoken text of a multi-line result', () => {
  it('reads each line as a sentence, without list markers', () => {
    expect(
      plain(
        'Solar co-op report\n\n- By Hanna Lindqvist\n- The year ended on 30 September.\n2) Done',
      ),
    ).toBe('Solar co-op report. By Hanna Lindqvist. The year ended on 30 September. Done.');
    expect(plain('  One line, kept as it is  ')).toBe('One line, kept as it is');
    expect(plain('⁨Layla⁩ asked')).toBe('Layla asked');
  });
});
