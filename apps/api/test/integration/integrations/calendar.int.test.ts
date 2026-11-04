/**
 * Calendars end to end (real Postgres + mock Google Calendar / Graph):
 * Home "Upcoming" from every source with its status, the calendar list
 * errors, events created after an approval that shows the exact instants,
 * zone and attendees, RECIPIENT_EXTERNAL for invitations, conflict detection,
 * changed-event detection, and meeting booking via free/busy (scenario 1a).
 */
import type { TaskDetail } from '@jarvis/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../../src/lib/errors';
import { AgentError } from '../../../src/modules/agent/errors';
import { integrations } from '../../../src/modules/integrations';
import { calendarClient } from '../../../src/modules/integrations/calendar';
import {
  addDays,
  localDate,
  localParts,
  zonedToUtc,
} from '../../../src/modules/integrations/timezones';
import { clearUpcomingCache } from '../../../src/modules/integrations/upcoming';
import { asOwner, detail, drain } from '../agent/harness';
import {
  HOUR,
  connect,
  createIntegrationsHarness,
  iso,
  newUserWithMailbox,
  type IntegrationsHarness,
} from './harness';

let h: IntegrationsHarness;
beforeAll(async () => {
  h = await createIntegrationsHarness();
});
afterAll(() => h.close());

type User = Awaited<ReturnType<typeof newUserWithMailbox>>;
const TZ = 'Europe/Berlin';

async function run(user: User, request: string): Promise<TaskDetail> {
  const t = await h.services.tasks.create(user, { request, source: 'text' }, {});
  await drain(h.worker);
  return detail(h.db, user, t.id);
}

async function approve(user: User, task: TaskDetail): Promise<TaskDetail> {
  const pending = task.approvals.find((a) => a.status === 'PENDING');
  if (!pending) throw new Error(`no pending approval (${task.status})`);
  await h.services.approvals.decide(
    user,
    pending.id,
    { decision: 'approve', actionHash: pending.actionHash },
    'web',
  );
  await drain(h.worker);
  return detail(h.db, user, task.id);
}

/** The local date of the next given weekday (1 = Monday) after today in TZ. */
function nextWeekday(day: number): string {
  const today = localDate(new Date(), TZ);
  const wd = localParts(new Date(), TZ).weekday;
  return addDays(today, (day - wd + 7) % 7 || 7);
}
const at = (date: string, hh: number, mm = 0) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return zonedToUtc(y, m, d, hh, mm, TZ);
};

describe('Home "Upcoming" and the calendar list', () => {
  it('is null without calendar.read; merges every source by start; reports expired and slow sources', async () => {
    const user = await newUserWithMailbox(h, { timeZone: TZ });
    expect(await integrations.upcomingEvents(h, user)).toBeNull();
    await connect(h, user, 'google', ['mail.read']);
    expect(await integrations.upcomingEvents(h, user)).toBeNull();

    const g = await connect(h, user, 'google', ['mail.read', 'calendar.read']);
    const m = await connect(h, user, 'microsoft', ['calendar.read']);
    h.google.addEvent(user.mailbox, {
      title: 'Dentist',
      start: iso(5 * HOUR),
      end: iso(6 * HOUR),
      timeZone: TZ,
    });
    h.microsoft.addEvent(user.mailbox, {
      title: 'Team sync',
      start: iso(2 * HOUR),
      end: iso(3 * HOUR),
      originalTimeZone: 'W. Europe Standard Time',
    });
    h.microsoft.addEvent(user.mailbox, {
      title: 'Next month',
      start: iso(40 * 24 * HOUR),
      end: iso(40 * 24 * HOUR + HOUR),
    });
    const up = (await integrations.upcomingEvents(h, user))!;
    expect(up.events.map((e) => [e.title, e.provider])).toEqual([
      ['Team sync', 'microsoft'],
      ['Dentist', 'google'],
    ]);
    expect(up.events[0]!.timeZone).toBe('Europe/Berlin'); // Windows zone mapped to IANA
    expect(up.sources.map((s) => [s.provider, s.status])).toEqual([
      ['google', 'ok'],
      ['microsoft', 'ok'],
    ]);

    // Microsoft's grant dies: its source says "expired", Home still answers.
    clearUpcomingCache();
    h.microsoft.revokeGrants(user.mailbox);
    h.microsoft.expireAccessTokens(user.mailbox);
    const later = (await integrations.upcomingEvents(h, user))!;
    expect(later.sources.find((s) => s.provider === 'microsoft')!.status).toBe('expired');
    expect(later.events.map((e) => e.title)).toEqual(['Dentist']);

    // A slow provider is "unavailable" within the Home timeout.
    clearUpcomingCache();
    h.google.failNext(
      { path: '/calendar/v3/' },
      { status: 200, delayMs: 1_500, passThrough: true },
    );
    const started = Date.now();
    const slow = (await integrations.upcomingEvents(h, user, { timeoutMs: 300 }))!;
    expect(Date.now() - started).toBeLessThan(1_400);
    expect(slow.sources.find((s) => s.connectionId === g.connection.id)!.status).toBe(
      'unavailable',
    );
    expect(slow.sources.find((s) => s.connectionId === m.connection.id)!.status).toBe('expired');
  });

  it('listEvents: window too wide → VALIDATION_FAILED; no calendar → 409 CALENDAR_NOT_CONNECTED; only source down → 503', async () => {
    const user = await newUserWithMailbox(h);
    const q = { from: iso(0), to: iso(2 * HOUR) };
    const err = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return e as AppError;
      }
      throw new Error('expected an error');
    };
    expect(await err(integrations.listEvents(h, user, q))).toMatchObject({
      status: 409,
      details: { reason: 'CALENDAR_NOT_CONNECTED' },
    });
    await connect(h, user, 'google', ['calendar.read']);
    expect(
      await err(integrations.listEvents(h, user, { from: iso(0), to: iso(63 * 24 * HOUR) })),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    h.google.addEvent(user.mailbox, { title: 'Call', start: iso(HOUR), end: iso(2 * HOUR) });
    const list = await integrations.listEvents(h, user, q);
    expect(list.items.map((e) => e.title)).toEqual(['Call']);
    expect(list.truncated).toBe(false);
    h.google.failNext({ path: '/calendar/v3/' }, h.google.errors.unavailable(503), 3);
    expect(await err(integrations.listEvents(h, user, q))).toMatchObject({
      status: 503,
      details: { reason: 'CALENDAR_UNAVAILABLE', provider: 'google' },
    });
  });

  it('offline: “what’s on my calendar tomorrow” reads the live events', async () => {
    const user = await newUserWithMailbox(h, { timeZone: TZ });
    await connect(h, user, 'google', ['calendar.read']);
    const tomorrow = addDays(localDate(new Date(), TZ), 1);
    h.google.addEvent(user.mailbox, {
      title: 'Physio',
      start: at(tomorrow, 9).toISOString(),
      end: at(tomorrow, 10).toISOString(),
      timeZone: TZ,
    });
    const done = await run(user, "What's on my calendar tomorrow?");
    expect(done.status).toBe('COMPLETED');
    expect(done.steps.map((s) => s.toolId)).toEqual(['calendar.list']);
    expect(done.resultSummary).toContain('Physio');
    expect(done.resultSummary).toContain('09:00');
  });
});

describe('creating events', () => {
  it('asks with the exact instant, zone and (no) attendees, writes it in the zone, verifies the times', async () => {
    const user = await newUserWithMailbox(h, { timeZone: TZ });
    await connect(h, user, 'google', ['calendar.read', 'calendar.write']);
    const day = nextWeekday(3);
    const waiting = await run(user, `Add Dentist to my calendar on ${day} at 15:00`);
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    const approval = waiting.approvals.find((a) => a.status === 'PENDING')!;
    expect(approval.reasons).toEqual(['RISK_MEDIUM']);
    expect(approval.details).toEqual({
      kind: 'calendar_event',
      action: 'create',
      provider: 'google',
      account: user.mailbox,
      eventId: null,
      title: 'Dentist',
      start: at(day, 15).toISOString(),
      end: at(day, 16).toISOString(),
      timeZone: TZ,
      allDay: false,
      location: null,
      description: null,
      attendees: [],
      notifyAttendees: false,
      previous: null,
      conflictCheck: true,
    });
    expect(approval.summaryMessage).toEqual({
      key: 'approval.eventCreate',
      params: { title: 'Dentist' },
    });
    const done = await approve(user, waiting);
    expect(done.status).toBe('COMPLETED');
    expect(done.resultSummaryMessage).toEqual({
      key: 'result.eventCreated',
      params: { title: 'Dentist' },
    });
    const [event] = h.google.events(user.mailbox);
    expect(event.summary).toBe('Dentist');
    expect(event.start.timeZone).toBe(TZ);
    expect(Date.parse(event.start.dateTime)).toBe(at(day, 15).getTime());
    expect(done.steps[0]!.evidence[0]).toMatchObject({
      code: 'CALENDAR_EVENT',
      params: { provider: 'google', action: 'create' },
    });
  });

  it('inviting someone else adds RECIPIENT_EXTERNAL and the provider sends the invitation', async () => {
    const user = await newUserWithMailbox(h, { timeZone: TZ });
    await connect(h, user, 'microsoft', ['calendar.read', 'calendar.write']);
    const day = nextWeekday(2);
    const waiting = await run(
      user,
      `Add Project sync with bob@example.org to my calendar on ${day} at 10:00 for 30 minutes`,
    );
    const approval = waiting.approvals.find((a) => a.status === 'PENDING')!;
    expect(approval.reasons).toEqual(['RISK_MEDIUM', 'RECIPIENT_EXTERNAL']);
    expect(approval.details).toMatchObject({
      kind: 'calendar_event',
      provider: 'microsoft',
      attendees: ['bob@example.org'],
      notifyAttendees: true,
      start: at(day, 10).toISOString(),
      end: at(day, 10, 30).toISOString(),
    });
    expect(approval.summaryMessage?.key).toBe('approval.eventInvite');
    const done = await approve(user, waiting);
    expect(done.status).toBe('COMPLETED');
    expect(
      h.microsoft.invitations.filter((i) => i.to === 'bob@example.org' && i.kind === 'invite'),
    ).toHaveLength(1);
    const [event] = h.microsoft.events(user.mailbox);
    expect(
      event.attendees.map((a: { emailAddress: { address: string } }) => a.emailAddress.address),
    ).toEqual(['bob@example.org']);
  });

  it('a busy time stops the write (CALENDAR_CONFLICT, nothing written)', async () => {
    const user = await newUserWithMailbox(h, { timeZone: TZ });
    await connect(h, user, 'google', ['calendar.read', 'calendar.write']);
    const day = nextWeekday(4);
    h.google.addEvent(user.mailbox, {
      title: 'Busy',
      start: at(day, 15).toISOString(),
      end: at(day, 16).toISOString(),
    });
    const waiting = await run(user, `Add Haircut to my calendar on ${day} at 15:30`);
    const done = await approve(user, waiting);
    expect(done.status).toBe('FAILED');
    expect(done.error).toMatchObject({
      code: 'TOOL_FAILED',
      reason: 'CALENDAR_CONFLICT',
      params: { count: 1 },
    });
    expect(h.google.events(user.mailbox).map((e) => e.summary)).toEqual(['Busy']);
  });

  it('an event changed since it was read is not overwritten (If-Match → EVENT_CHANGED)', async () => {
    const user = await newUserWithMailbox(h, { timeZone: TZ });
    for (const provider of ['google', 'microsoft'] as const) {
      const { connection } = await connect(h, user, provider, ['calendar.read', 'calendar.write']);
      const mock = provider === 'google' ? h.google : h.microsoft;
      const id = mock.addEvent(user.mailbox, {
        title: 'Review',
        start: iso(26 * HOUR),
        end: iso(27 * HOUR),
      });
      const client = calendarClient(
        h,
        user,
        { id: connection.id, provider, accountIdentifier: user.mailbox },
        TZ,
      );
      const read = (await client.get(id))!;
      // Someone else edits it.
      await client.update(
        id,
        {
          title: 'Review (moved)',
          start: new Date(iso(28 * HOUR)),
          end: new Date(iso(29 * HOUR)),
          timeZone: TZ,
          allDay: false,
          location: null,
          description: null,
          attendees: [],
        },
        { etag: read.etag, notify: false },
      );
      const stale = await client
        .update(
          id,
          {
            title: 'Mine',
            start: new Date(iso(30 * HOUR)),
            end: new Date(iso(31 * HOUR)),
            timeZone: TZ,
            allDay: false,
            location: null,
            description: null,
            attendees: [],
          },
          { etag: read.etag, notify: false },
        )
        .catch((e: unknown) => e);
      expect(stale).toBeInstanceOf(AgentError);
      expect((stale as AgentError).reason).toBe('EVENT_CHANGED');
      expect((await client.get(id))!.title).toBe('Review (moved)');
    }
  });
});

describe('meeting booking via calendars (scenario 1a)', () => {
  it('proposes mutual free times from free/busy, then books the chosen one with an invitation after approval', async () => {
    const user = await newUserWithMailbox(h, { timeZone: TZ });
    await connect(h, user, 'google', ['calendar.read', 'calendar.write']);
    const day = nextWeekday(2);
    // Bob is busy 08:00–10:00, the owner 10:00–10:30 (Berlin): the first mutual 30 minutes are at 10:30.
    h.google.setFreeBusy('bob@example.org', [
      { start: at(day, 8).toISOString(), end: at(day, 10).toISOString() },
    ]);
    h.google.addEvent(user.mailbox, {
      title: 'Standup',
      start: at(day, 10).toISOString(),
      end: at(day, 10, 30).toISOString(),
    });
    h.google.setFreeBusy('carol@example.org', null); // not shared
    const proposals = await run(
      user,
      'Find a time to meet bob@example.org and carol@example.org on Tuesday for 30 minutes',
    );
    expect(proposals.status).toBe('COMPLETED');
    expect(proposals.titleMessage).toEqual({
      key: 'plan.findMeetingTime',
      params: { who: 'bob@example.org, carol@example.org' },
    });
    // The stored output (TaskDetail carries the display-safe preview).
    const [stored] = await asOwner<{ output: unknown }>(
      'SELECT output FROM task_steps WHERE id = $1',
      [proposals.steps[0]!.id],
    );
    const fb = stored!.output as {
      result: {
        slots: { start: string; end: string }[];
        calendars: { email: string; accessible: boolean }[];
      };
      text: string;
    };
    expect(fb.result.slots[0]).toEqual({
      start: at(day, 10, 30).toISOString(),
      end: at(day, 11).toISOString(),
    });
    expect(fb.result.calendars.find((c) => c.email === 'carol@example.org')!.accessible).toBe(
      false,
    );
    expect(fb.text).toContain('carol@example.org'); // said honestly: not shared, not assumed free
    expect(fb.text).toContain('10:30');
    const freeBusyCall = h.google.requests.find(
      (r) => r.path === '/calendar/v3/freeBusy' && r.auth?.account === user.mailbox,
    )!;
    expect((freeBusyCall.body as { timeZone: string }).timeZone).toBe(TZ);

    // The follow-up books the chosen time with the people of the first request.
    const follow = await h.services.tasks.followUp(
      user,
      proposals.conversationId,
      { request: 'Book Tuesday 10:30', source: 'text' },
      {},
    );
    await drain(h.worker);
    const waiting = await detail(h.db, user, follow.id);
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    const approval = waiting.approvals.find((a) => a.status === 'PENDING')!;
    expect(approval.reasons).toEqual(['RISK_MEDIUM', 'RECIPIENT_EXTERNAL']);
    expect(approval.details).toMatchObject({
      kind: 'calendar_event',
      title: 'Meeting with bob@example.org, carol@example.org',
      start: at(day, 10, 30).toISOString(),
      end: at(day, 11).toISOString(),
      timeZone: TZ,
      attendees: ['bob@example.org', 'carol@example.org'],
      notifyAttendees: true,
      conflictCheck: true,
    });
    const done = await approve(user, waiting);
    expect(done.status).toBe('COMPLETED');
    const created = h.google
      .events(user.mailbox)
      .find((e) => e.summary.startsWith('Meeting with'))!;
    expect(Date.parse(created.start.dateTime)).toBe(at(day, 10, 30).getTime());
    expect(
      h.google.invitations
        .filter((i) => i.eventId === created.id)
        .map((i) => i.to)
        .sort(),
    ).toEqual(['bob@example.org', 'carol@example.org']);
    // Exactly once: the event id is derived from the step's key.
    const exec = await asOwner<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM tool_executions WHERE task_id = $1 AND tool_id = 'calendar.create_event'",
      [follow.id],
    );
    expect(exec).toHaveLength(1);
  });

  it('Graph getSchedule: an unknown mailbox is inaccessible and not assumed free', async () => {
    const user = await newUserWithMailbox(h, { timeZone: TZ });
    const { connection } = await connect(h, user, 'microsoft', ['calendar.read']);
    const day = nextWeekday(1);
    h.microsoft.setFreeBusy('dana@example.org', [
      { start: at(day, 9).toISOString(), end: at(day, 12).toISOString() },
    ]);
    const client = calendarClient(
      h,
      user,
      { id: connection.id, provider: 'microsoft', accountIdentifier: user.mailbox },
      TZ,
    );
    const calendars = await client.freeBusy({
      from: at(day, 0),
      to: at(day, 23),
      timeZone: TZ,
      emails: ['dana@example.org', 'nobody@example.org'],
    });
    expect(calendars.map((c) => [c.email, c.accessible, c.busy.length])).toEqual([
      [user.mailbox, true, 0],
      ['dana@example.org', true, 1],
      ['nobody@example.org', false, 0],
    ]);
  });
});
