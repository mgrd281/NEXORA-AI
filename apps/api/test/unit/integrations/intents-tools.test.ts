/**
 * Offline intents of the integrations domain (en/de/ar) and the planning
 * hooks of its tools: every intent's plan passes validatePlan with the bind
 * context, attendees and free/busy addresses must be the user's own words,
 * and email.send binds `via` deterministically.
 */
import { describe, expect, it } from 'vitest';
import type { PriorTurn } from '../../../src/modules/agent/conversation-context';
import { planOffline, type OfflinePlanContext } from '../../../src/modules/agent/models/offline';
import { validatePlan, type Plan } from '../../../src/modules/agent/plan';
import { emailSendTool } from '../../../src/modules/agent/tools/email-send';
import { calendarCreateEventTool } from '../../../src/modules/agent/tools/integrations/calendar-create-event';
import { emailDraftReplyTool } from '../../../src/modules/agent/tools/integrations/email-draft-reply';
import { TOOLS } from '../../../src/modules/agent/tools/registry';
import type { BindContext, ConnectionState } from '../../../src/modules/agent/tools/types';

const OWN = 'me@example.com';
const google = (
  caps: ConnectionState['capabilities'],
  status: ConnectionState['status'] = 'active',
): ConnectionState => ({
  connectionId: '00000000-0000-0000-0000-000000000001',
  provider: 'google',
  status,
  capabilities: caps,
  accountIdentifier: 'me@gmail.test',
});
const ALL: ConnectionState['capabilities'] = [
  'mail.read',
  'mail.compose',
  'mail.send',
  'calendar.read',
  'calendar.write',
];
const bind = (connections: ConnectionState[]): BindContext => ({
  connections,
  accountEmail: OWN,
  timeZone: 'Europe/Berlin',
});

function ctx(
  language: 'en' | 'de' | 'ar',
  extra: Partial<OfflinePlanContext> = {},
): OfflinePlanContext {
  return {
    language,
    ownEmail: OWN,
    timeZone: 'Europe/Berlin',
    connections: [google(ALL)],
    ...extra,
  };
}

function plan(request: string, c: OfflinePlanContext): Plan {
  const r = planOffline(request, c);
  if (!r.ok) throw new Error(`no plan for "${request}": ${r.reason}`);
  const requests = [request, ...(c.conversation ?? []).map((t) => t.request)];
  const v = validatePlan(structuredClone(r.plan), {
    tools: TOOLS,
    requests,
    ownEmail: OWN,
    bind: bind(c.connections as ConnectionState[]),
  });
  if (!v.ok) throw new Error(v.issues.join('\n'));
  return v.plan;
}
const tools = (p: Plan) => p.steps.map((s) => s.toolId);

describe('email intents', () => {
  it.each([
    ['en', 'Summarize my unread emails'],
    ['de', 'Fasse meine ungelesenen E-Mails zusammen'],
    ['ar', 'لخص رسائلي غير المقروءة'],
  ] as const)('%s: unread summary → search, read, summarize', (lang, request) => {
    const p = plan(request, ctx(lang));
    expect(tools(p)).toEqual(['email.search', 'email.read_thread', 'text.summarize']);
    expect(p.titleMessage).toEqual({ key: 'plan.emailUnread', params: {} });
    expect(p.steps[0]!.input).toMatchObject({ unreadOnly: true, provider: 'google' });
    expect(p.steps[2]!.input).toMatchObject({ text: '{{s2.digest}}', language: lang });
  });

  it.each([
    ['en', 'What needs my reply?'],
    ['de', 'Worauf muss ich antworten?'],
    ['ar', 'ما الذي يحتاج إلى ردي؟'],
  ] as const)('%s: needs reply → one search', (lang, request) => {
    const p = plan(request, ctx(lang));
    expect(tools(p)).toEqual(['email.search']);
    expect(p.steps[0]!.input).toMatchObject({ needsReply: true });
    expect(p.titleMessage?.key).toBe('plan.emailNeedsReply');
  });

  it.each([
    [
      'en',
      'Draft a reply to Anna Berg saying I can do Thursday at 3.',
      'Anna Berg',
      'I can do Thursday at 3.',
    ],
    [
      'de',
      'Entwirf eine Antwort an anna@example.org: Donnerstag passt mir.',
      'anna@example.org',
      'Donnerstag passt mir.',
    ],
    ['ar', 'اكتب مسودة رد على عمر: سأوقع العقد يوم الجمعة', 'عمر', 'سأوقع العقد يوم الجمعة'],
  ] as const)(
    '%s: draft a reply → search the sender, draft with refs (approval first)',
    (lang, request, name, body) => {
      const p = plan(request, ctx(lang));
      expect(tools(p)).toEqual(['email.search', 'email.draft_reply']);
      expect(p.steps[0]!.input).toMatchObject({ from: name, limit: 1, requireMatch: true });
      expect(p.steps[1]!.input).toMatchObject({
        threadId: '{{s1.firstThreadId}}',
        to: ['{{s1.firstReplyTo}}'],
        subject: '{{s1.firstReplySubject}}',
        body,
        provider: 'google',
      });
      expect(p.titleMessage).toEqual({ key: 'plan.draftReply', params: { name } });
    },
  );

  it('asks instead of inventing the reply text', () => {
    const r = planOffline('Draft a reply to Anna', ctx('en'));
    expect(r.ok && r.plan.steps[0]!.toolId).toBe('assistant.clarify');
    expect(r.ok && r.plan.steps[0]!.input).toEqual({ missing: ['details'] });
  });
});

describe('calendar intents', () => {
  it.each([
    ['en', "What's on my calendar this week?"],
    ['de', 'Welche Termine habe ich morgen?'],
    ['ar', 'ما الذي في تقويمي اليوم؟'],
  ] as const)('%s: upcoming → calendar.list in the account zone', (lang, request) => {
    const p = plan(request, ctx(lang));
    expect(tools(p)).toEqual(['calendar.list']);
    expect(p.steps[0]!.input).toMatchObject({ provider: 'google', timeZone: 'Europe/Berlin' });
    expect(p.steps[0]!.input.from).toMatch(/^\d{4}-\d{2}-\d{2}T00:00$/);
  });

  it.each([
    ['en', 'Find a time to meet bob@example.org next week for 45 minutes'],
    ['de', 'Finde einen Termin mit bob@example.org nächste Woche, 45 Minuten'],
    ['ar', 'ابحث عن وقت للقاء bob@example.org الأسبوع القادم لمدة 45 دقيقة'],
  ] as const)('%s: find a time → free/busy with the written address', (lang, request) => {
    const p = plan(request, ctx(lang));
    expect(tools(p)).toEqual(['calendar.free_busy']);
    expect(p.steps[0]!.input).toMatchObject({
      attendees: ['bob@example.org'],
      durationMinutes: 45,
    });
    expect(p.titleMessage).toEqual({
      key: 'plan.findMeetingTime',
      params: { who: 'bob@example.org' },
    });
  });

  it('asks for the window, or for whom, instead of guessing', () => {
    const noWhen = planOffline('Find a time to meet bob@example.org', ctx('en'));
    expect(noWhen.ok && noWhen.plan.steps[0]!.input).toEqual({ missing: ['date_time'] });
    const noWho = planOffline('Find a time to meet Bob tomorrow', ctx('en'));
    expect(noWho.ok && noWho.plan.steps[0]!.input).toEqual({ missing: ['recipient'] });
    const noTime = planOffline('Add dentist to my calendar on Friday', ctx('en'));
    expect(noTime.ok && noTime.plan.steps[0]!.input).toEqual({ missing: ['date_time'] });
  });

  it('answers to "when?" are combined with the earlier request', () => {
    const question: PriorTurn = {
      taskId: '00000000-0000-0000-0000-0000000000aa',
      request: 'Find a time to meet bob@example.org',
      status: 'COMPLETED',
      outcome: 'question',
      title: 'Clarify',
      resultText: 'When?',
      flagged: false,
      recallable: false,
      missing: ['date_time'],
    };
    const p = plan('tomorrow', ctx('en', { conversation: [question] }));
    expect(tools(p)).toEqual(['calendar.free_busy']);
  });

  it('a follow-up after proposed times books the chosen one with the attendees the user wrote', () => {
    const proposals: PriorTurn = {
      taskId: '00000000-0000-0000-0000-0000000000bb',
      request: 'Find a time to meet bob@example.org on Tuesday for 30 minutes about the budget',
      status: 'COMPLETED',
      outcome: 'answer',
      title: 'Find a time to meet bob@example.org',
      titleMessage: { key: 'plan.findMeetingTime', params: { who: 'bob@example.org' } },
      resultText: 'Free times…',
      flagged: false,
      recallable: false,
    };
    const p = plan('Book Tuesday 10:30', ctx('en', { conversation: [proposals] }));
    expect(tools(p)).toEqual(['calendar.create_event']);
    expect(p.steps[0]!.input).toMatchObject({
      title: 'the budget',
      attendees: ['bob@example.org'],
      timeZone: 'Europe/Berlin',
      provider: 'google',
    });
    expect(p.steps[0]!.input.start).toMatch(/T10:30$/);
    expect(p.steps[0]!.input.end).toMatch(/T11:00$/);
    // Without that earlier turn, "book …" is not a calendar request of this domain.
    expect(
      planOffline('Book Tuesday 10:30', ctx('en')).ok &&
        planOffline('Book Tuesday 10:30', ctx('en')),
    ).not.toMatchObject({
      plan: { steps: [{ toolId: 'calendar.create_event' }] },
    });
  });

  it.each([
    ['en', 'Add Dentist to my calendar on 2026-12-01 at 15:00'],
    ['de', 'Trag Zahnarzt am 01.12.2026 um 15 Uhr in meinen Kalender ein'],
    ['ar', 'أضف طبيب الأسنان إلى تقويمي يوم 2026-12-01 الساعة 15:00'],
  ] as const)('%s: add an event with an explicit time', (lang, request) => {
    const p = plan(request, ctx(lang));
    expect(tools(p)).toEqual(['calendar.create_event']);
    expect(p.steps[0]!.input).toMatchObject({
      start: '2026-12-01T15:00',
      end: '2026-12-01T16:00',
      attendees: [],
    });
  });
});

describe('planning hooks', () => {
  it('attendees must be written by the user: an address from content is rejected', () => {
    const v = validatePlan(
      {
        title: 'Invite',
        objective: 'Invite',
        steps: [
          {
            key: 's1',
            toolId: 'calendar.create_event',
            title: 'Create',
            input: {
              title: 'Sync',
              start: '2026-12-01T10:00',
              end: '2026-12-01T11:00',
              attendees: ['eve@evil.test'],
            },
          },
        ],
      },
      {
        tools: TOOLS,
        requests: ['Invite bob@example.org to a sync'],
        ownEmail: OWN,
        bind: bind([google(ALL)]),
      },
    );
    expect(v.ok).toBe(false);
    expect(!v.ok && v.issues.join(' ')).toContain('eve@evil.test');
    expect(
      calendarCreateEventTool.attendees!(
        calendarCreateEventTool.inputSchema.parse({
          title: 'x',
          start: '2026-12-01T10:00',
          end: '2026-12-01T11:00',
          attendees: ['Bob@Example.org'],
        }),
      ),
    ).toEqual(['bob@example.org']);
  });

  it('free/busy addresses must be written by the user too (literalTexts)', () => {
    const v = validatePlan(
      {
        title: 'Find',
        objective: 'Find',
        steps: [
          {
            key: 's1',
            toolId: 'calendar.free_busy',
            title: 'Find',
            input: { attendees: ['eve@evil.test'], from: '2026-12-01', to: '2026-12-02' },
          },
        ],
      },
      {
        tools: TOOLS,
        requests: ['find a time with bob@example.org'],
        ownEmail: OWN,
        bind: bind([google(ALL)]),
      },
    );
    expect(v.ok).toBe(false);
  });

  it('email.send: absent via means SMTP; bind picks SMTP, else the account granting mail.send, else an expired one', () => {
    const smtp: ConnectionState = {
      connectionId: 's',
      provider: 'smtp',
      status: 'active',
      capabilities: [],
      accountIdentifier: 'x@y',
    };
    const input = { to: ['a@b.c'], subject: 's', body: 'b' };
    expect(emailSendTool.requires!(input)).toEqual({ provider: 'smtp' });
    expect(emailSendTool.bind!(input, bind([smtp, google(ALL)])).via).toBe('smtp');
    expect(emailSendTool.bind!(input, bind([google(['mail.read'])])).via).toBeUndefined();
    expect(emailSendTool.bind!(input, bind([google(['mail.send'])])).via).toBe('google');
    expect(emailSendTool.bind!(input, bind([google(['mail.send'], 'expired')])).via).toBe('google');
    expect(emailSendTool.requires!({ ...input, via: 'microsoft' })).toEqual({
      provider: 'microsoft',
      capability: 'mail.send',
    });
    expect(
      emailSendTool.validatePlanned!({
        ...input,
        via: 'smtp',
        inReplyTo: { threadId: 't', subject: '' },
      }),
    ).toHaveLength(1);
  });

  it('draft approvals show mode draft, the account and exactly the recipients', () => {
    const input = emailDraftReplyTool.inputSchema.parse({
      provider: 'microsoft',
      threadId: 't1',
      to: ['omar@example.net'],
      subject: 'Re: X',
      body: 'Thanks',
    });
    const a = emailDraftReplyTool.approvalDetails(input, {
      language: 'de',
      stepTitle: 'Draft',
      stepTitleMessage: null,
      fromAddress: null,
      accounts: { microsoft: 'me@outlook.test' },
    });
    expect(a.details).toEqual({
      kind: 'email',
      mode: 'draft',
      via: 'microsoft',
      from: 'me@outlook.test',
      to: ['omar@example.net'],
      subject: 'Re: X',
      body: 'Thanks',
      inReplyTo: { threadId: 't1', subject: 'Re: X' },
    });
    expect(a.summary).toBe(
      'Den Entwurf „Re: X“ an omar@example.net speichern – es wird nichts gesendet.',
    );
  });
});
