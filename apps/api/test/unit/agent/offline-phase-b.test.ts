/**
 * Offline planner, Phase B: follow-ups on an earlier result, clarifying
 * questions, answers to them, documents and schedules — en/de/ar. Every plan
 * must also pass validatePlan with the same deterministic context the runtime
 * passes (requests, recallable task ids, attachment ids).
 */
import { describe, expect, it } from 'vitest';
import type { PriorTurn } from '../../../src/modules/agent/conversation-context';
import {
  clarifyMissing,
  planOffline,
  type OfflinePlanContext,
  type PlanningAttachment,
} from '../../../src/modules/agent/models/offline';
import { validatePlan } from '../../../src/modules/agent/plan';
import { TOOLS } from '../../../src/modules/agent/tools/registry';

const OWN = 'me@example.com';
const SUMMARY_TASK = '11111111-1111-4111-8111-111111111111';
const QUESTION_TASK = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const OLD_FILE = '44444444-4444-4444-8444-444444444444';

const summaryTurn: PriorTurn = {
  taskId: SUMMARY_TASK,
  request: 'Summarize https://example.com/article',
  status: 'COMPLETED',
  outcome: 'answer',
  title: 'Summarize example.com',
  resultText: 'Renewables overtook coal.',
  flagged: false,
  recallable: true,
};

function questionTurn(request: string, missing: PriorTurn['missing']): PriorTurn {
  return {
    taskId: QUESTION_TASK,
    request,
    status: 'COMPLETED',
    outcome: 'question',
    title: 'Question about your request',
    resultText: 'What should the email say?',
    flagged: false,
    recallable: false,
    missing,
  };
}

const file = (over: Partial<PlanningAttachment> = {}): PlanningAttachment => ({
  id: FILE,
  filename: 'report.pdf',
  mediaType: 'application/pdf',
  sizeBytes: 1200,
  pageCount: null,
  attachedToRequest: true,
  ...over,
});

function run(
  request: string,
  opts: Partial<OfflinePlanContext> = {},
  language: 'en' | 'de' | 'ar' = 'en',
) {
  const ctx: OfflinePlanContext = {
    language,
    ownEmail: OWN,
    timeZone: 'Europe/Berlin',
    ...opts,
  };
  const r = planOffline(request, ctx);
  if (!r.ok) return { result: r, plan: null };
  const turns = ctx.conversation ?? [];
  const v = validatePlan(structuredClone(r.plan), {
    tools: TOOLS,
    requests: [request, ...turns.map((t) => t.request)],
    ownEmail: OWN,
    conversationTaskIds: turns.filter((t) => t.recallable).map((t) => t.taskId),
    attachmentIds: (ctx.attachments ?? []).map((a) => a.id),
  });
  if (!v.ok) throw new Error(`offline plan for "${request}" invalid: ${v.issues.join('; ')}`);
  return { result: r, plan: v.plan };
}

const tools = (
  request: string,
  opts: Partial<OfflinePlanContext> = {},
  lang?: 'en' | 'de' | 'ar',
) => run(request, opts, lang).plan?.steps.map((s) => s.toolId) ?? null;

describe('follow-ups on an earlier result', () => {
  it.each([
    ['email it to me', 'en'],
    ['Email it to me please', 'en'],
    ['send me that', 'en'],
    ['send that to me.', 'en'],
    ['Can you email me the summary?', 'en'],
    ['forward it to me', 'en'],
    ['schick mir das', 'de'],
    ['Schick es mir bitte', 'de'],
    ['schick mir das per Mail', 'de'],
    ['sende mir die Zusammenfassung', 'de'],
    ['أرسله لي', 'ar'],
    ['أرسل لي ذلك', 'ar'],
    ['ارسل لي الملخص بالبريد', 'ar'],
  ] as const)('%s → recall + email to self', (request, lang) => {
    const { plan } = run(request, { conversation: [summaryTurn] }, lang);
    expect(plan!.steps.map((s) => s.toolId)).toEqual(['conversation.recall', 'email.send']);
    expect(plan!.steps[0]!.input).toEqual({ taskId: SUMMARY_TASK });
    expect(plan!.steps[1]!.input).toMatchObject({ to: [OWN], body: '{{s1.text}}' });
    expect(plan!.titleMessage).toEqual({
      key: 'plan.emailResult',
      params: { title: 'Summarize example.com' },
    });
    expect(plan!.steps.map((s) => s.titleMessage?.key)).toEqual([
      'step.recall',
      'step.emailResult',
    ]);
  });

  it('uses the newest recallable turn, skipping a question in between', () => {
    const other: PriorTurn = { ...summaryTurn, taskId: '55555555-5555-4555-8555-555555555555' };
    const { plan } = run('email it to me', {
      conversation: [summaryTurn, other, questionTurn('email me', ['email_content'])],
    });
    // The question turn is last, but "email it to me" is no answer to "what should it say".
    expect(plan!.steps[0]!.input).toEqual({ taskId: other.taskId });
  });

  it('sends to an address the user wrote (approval follows from policy)', () => {
    const { plan } = run('send it to bob@example.org', { conversation: [summaryTurn] });
    expect(plan!.steps[1]!.input).toMatchObject({ to: ['bob@example.org'] });
  });

  it('asks for the address when only a name is given, then completes with the answer', () => {
    const asked = run('send it to Bob', { conversation: [summaryTurn] });
    expect(clarifyMissing(asked.result)).toEqual(['recipient']);
    const turns = [summaryTurn, questionTurn('send it to Bob', ['recipient'])];
    const { plan } = run('bob@example.org', { conversation: turns });
    expect(plan!.steps.map((s) => s.toolId)).toEqual(['conversation.recall', 'email.send']);
    expect(plan!.steps[1]!.input).toMatchObject({ to: ['bob@example.org'] });
  });

  it('asks which result when there is none', () => {
    for (const [request, lang] of [
      ['email it to me', 'en'],
      ['schick mir das', 'de'],
      ['أرسله لي', 'ar'],
      ['remember that', 'en'],
    ] as const) {
      const r = run(request, {}, lang);
      expect(clarifyMissing(r.result), request).toEqual(['previous_result']);
    }
  });

  it.each([
    ['remember that', 'en'],
    ['Remember this.', 'en'],
    ['merk dir das', 'de'],
    ['تذكر ذلك', 'ar'],
  ] as const)('%s → recall + memory.save of the excerpt', (request, lang) => {
    const { plan } = run(request, { conversation: [summaryTurn] }, lang);
    expect(plan!.steps.map((s) => s.toolId)).toEqual(['conversation.recall', 'memory.save']);
    expect(plan!.steps[1]!.input).toEqual({ content: '{{s1.excerpt}}', kind: 'fact' });
  });

  it('"remember that X" with content stays a plain memory', () => {
    expect(tools('remember that I prefer tea', { conversation: [summaryTurn] })).toEqual([
      'memory.save',
    ]);
  });
});

describe('clarifying questions (ask instead of inventing)', () => {
  it.each([
    ['email me', 'email_content', 'en'],
    ['Send me an email', 'email_content', 'en'],
    ['schick mir eine E-Mail', 'email_content', 'de'],
    ['أرسل لي بريدا', 'email_content', 'ar'],
    ['summarize the page', 'url', 'en'],
    ['Fasse die Seite zusammen', 'url', 'de'],
    ['لخص الصفحة', 'url', 'ar'],
    ['summarize the document', 'document', 'en'],
    ['fasse das Dokument zusammen', 'document', 'de'],
    ['لخص المستند', 'document', 'ar'],
    ['every Monday summarize https://example.com/news', 'schedule_time', 'en'],
    ['jeden Montag fasse https://example.com/news zusammen', 'schedule_time', 'de'],
  ] as const)('%s → assistant.clarify %s', (request, missing, lang) => {
    const { result, plan } = run(request, {}, lang);
    expect(clarifyMissing(result)).toEqual([missing]);
    expect(plan!.titleMessage?.key).toBe('plan.clarify');
    expect(plan!.steps[0]!.titleMessage?.key).toBe('step.clarify');
  });

  it('the answer to "what should the email say" becomes the email', () => {
    const turns = [questionTurn('email me', ['email_content'])];
    const { plan } = run('Pick up the parcel before 6', { conversation: turns });
    expect(plan!.steps.map((s) => s.toolId)).toEqual(['email.send']);
    expect(plan!.steps[0]!.input).toEqual({
      to: [OWN],
      subject: 'Pick up the parcel before 6',
      body: 'Pick up the parcel before 6',
    });
  });

  it('a link answering "which page" re-plans the earlier request', () => {
    const turns = [questionTurn('summarize the page and email it to me', ['url'])];
    const { plan } = run('https://example.com/a', { conversation: turns });
    expect(plan!.steps.map((s) => s.toolId)).toEqual(['web.fetch', 'text.summarize', 'email.send']);
    expect(plan!.steps[0]!.input).toEqual({ url: 'https://example.com/a' });
  });

  it('a question stored without `missing` is re-derived from its request', () => {
    const turns = [questionTurn('email me', undefined)];
    expect(tools('Call the bank', { conversation: turns })).toEqual(['email.send']);
  });

  it('a time answering "when" completes the schedule', () => {
    const turns = [
      questionTurn('every Monday summarize https://example.com/news', ['schedule_time']),
    ];
    const { plan } = run('at 9', { conversation: turns });
    expect(plan!.steps[0]!.toolId).toBe('schedule.create');
  });

  it('a file answering "which document" summarizes it', () => {
    const turns = [questionTurn('summarize the document', ['document'])];
    expect(tools('here it is', { conversation: turns, attachments: [file()] })).toEqual([
      'document.analyze',
    ]);
  });
});

describe('documents', () => {
  it.each([
    ['Summarize the attached document', 'en'],
    ['summarize this', 'en'],
    ["What's in this file?", 'en'],
    ['Fasse das Dokument zusammen', 'de'],
    ['Was steht in der Datei?', 'de'],
    ['لخص المستند', 'ar'],
  ] as const)('%s + attachment → document.analyze', (request, lang) => {
    const { plan } = run(request, { attachments: [file()] }, lang);
    expect(plan!.steps.map((s) => s.toolId)).toEqual(['document.analyze']);
    expect(plan!.steps[0]!.input).toEqual({ attachmentId: FILE, mode: 'summary', language: lang });
    expect(plan!.titleMessage).toEqual({
      key: 'plan.summarizeDocument',
      params: { name: 'report.pdf' },
    });
  });

  it('summarize and email it to me', () => {
    const { plan } = run('Summarize the document and email it to me', { attachments: [file()] });
    expect(plan!.steps.map((s) => s.toolId)).toEqual(['document.analyze', 'email.send']);
    expect(plan!.steps[1]!.input).toMatchObject({ to: [OWN] });
    expect(String(plan!.steps[1]!.input.body)).toContain('{{s1.result}}');
  });

  it('one step per attached file; an earlier file only when the request names a document', () => {
    const second = file({ id: OLD_FILE, filename: 'b.docx', attachedToRequest: true });
    expect(tools('summarize these files', { attachments: [file(), second] })).toEqual([
      'document.analyze',
      'document.analyze',
    ]);
    const earlier = file({ attachedToRequest: false });
    const { plan } = run('summarize the document again', { attachments: [earlier] });
    expect(plan!.steps[0]!.input).toMatchObject({ attachmentId: FILE });
  });

  it('a link in the request still means the page', () => {
    expect(tools('summarize https://example.com/a', { attachments: [file()] })).toEqual([
      'web.fetch',
      'text.summarize',
    ]);
  });
});

describe('schedules', () => {
  it.each([
    [
      'every Monday at 9 summarize https://example.com/news and email it to me',
      { frequency: 'weekly', byWeekday: ['MO'], time: '09:00' },
      'Summarize https://example.com/news and email it to me',
      'en',
    ],
    [
      'Every day at 7:30am summarize https://example.com/a',
      { frequency: 'daily', time: '07:30' },
      'Summarize https://example.com/a',
      'en',
    ],
    [
      'summarize https://example.com/a every weekday at 6 pm',
      { frequency: 'weekly', byWeekday: ['MO', 'TU', 'WE', 'TH', 'FR'], time: '18:00' },
      'Summarize https://example.com/a',
      'en',
    ],
    [
      'every month on the 1st at 8 summarize https://example.com/a',
      { frequency: 'monthly', byMonthDay: [1], time: '08:00' },
      'Summarize https://example.com/a',
      'en',
    ],
    [
      'jeden Montag um 9 Uhr fasse https://example.com/news zusammen und schick sie mir',
      { frequency: 'weekly', byWeekday: ['MO'], time: '09:00' },
      'Fasse https://example.com/news zusammen und schick sie mir',
      'de',
    ],
    [
      'täglich um 18:15 fasse https://example.com/a zusammen',
      { frequency: 'daily', time: '18:15' },
      'Fasse https://example.com/a zusammen',
      'de',
    ],
    [
      'كل يوم اثنين الساعة 9 لخص https://example.com/news وأرسله لي',
      { frequency: 'weekly', byWeekday: ['MO'], time: '09:00' },
      'لخص https://example.com/news وأرسله لي',
      'ar',
    ],
  ] as const)('%s', (request, recurrence, rest, lang) => {
    const { plan } = run(request, {}, lang);
    expect(plan!.steps.map((s) => s.toolId)).toEqual(['schedule.create']);
    const input = plan!.steps[0]!.input as {
      request: string;
      recurrence: Record<string, unknown>;
      title: string;
    };
    expect(input.request).toBe(rest);
    expect(input.recurrence).toEqual({
      interval: 1,
      timeZone: 'Europe/Berlin',
      ...recurrence,
    });
    expect(plan!.titleMessage?.key).toBe('plan.schedule');
  });

  it.each([
    ['daily at 7 summarize https://example.com/a', { frequency: 'daily', time: '07:00' }, 'en'],
    [
      'on Mondays at 9 summarize https://example.com/a',
      { frequency: 'weekly', byWeekday: ['MO'], time: '09:00' },
      'en',
    ],
    [
      'every Monday and Thursday at 18:30 summarize https://example.com/a',
      { frequency: 'weekly', byWeekday: ['MO', 'TH'], time: '18:30' },
      'en',
    ],
    [
      'montags um 8 fasse https://example.com/a zusammen',
      { frequency: 'weekly', byWeekday: ['MO'], time: '08:00' },
      'de',
    ],
    [
      'monatlich am 15. um 7 Uhr fasse https://example.com/a zusammen',
      { frequency: 'monthly', byMonthDay: [15], time: '07:00' },
      'de',
    ],
    [
      'كل يوم الساعة ٨ مساءً لخص https://example.com/a',
      { frequency: 'daily', time: '20:00' },
      'ar',
    ],
  ] as const)('%s → schedule', (request, recurrence, lang) => {
    const { plan } = run(request, {}, lang);
    expect(plan!.steps[0]!.toolId).toBe('schedule.create');
    expect(plan!.steps[0]!.input.recurrence).toMatchObject(recurrence);
  });

  it.each([
    'Summarize every article on https://example.com/blog',
    'Summarize the daily digest at https://example.com/d',
    "Summarize https://example.com/a about Monday's election",
    'Summarize the monthly report https://example.com/r',
  ])('%s is not a schedule', (request) => {
    expect(tools(request)).toEqual(['web.fetch', 'text.summarize']);
  });

  it('a recurring phrase the offline planner cannot express asks for the timing', () => {
    const { result } = run('every two weeks summarize https://example.com/a');
    expect(clarifyMissing(result)).toEqual(['schedule_time']);
  });

  it('a schedule of something the offline planner cannot run is refused honestly', () => {
    const { result } = run('every day at 9 tell me a joke');
    expect(result.ok).toBe(false);
  });

  it('a schedule whose task lacks a link asks for it', () => {
    const { result } = run('every Monday at 9 summarize the page');
    expect(clarifyMissing(result)).toEqual(['url']);
  });
});

describe('translation is model-only', () => {
  it.each([
    'Translate "good morning" into German',
    'translate https://example.com/a to French',
    'Übersetze das ins Englische',
    'ترجم هذا إلى الإنجليزية',
  ])('%s → PLANNER_UNSUPPORTED / OFFLINE_UNSUPPORTED', (request) => {
    const { result } = run(request, { conversation: [summaryTurn] });
    expect(result).toMatchObject({
      ok: false,
      code: 'PLANNER_UNSUPPORTED',
      reason: 'OFFLINE_UNSUPPORTED',
    });
  });
});
