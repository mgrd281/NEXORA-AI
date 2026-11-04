import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SCHEDULE_LIMITS,
  type Schedule,
  type ScheduleDetail,
  type SchedulePreview,
} from '@jarvis/contracts';
import { withContext } from '../../../src/db/pool';
import {
  advanceSchedule,
  lockDueSchedule,
  recordScheduleRunResult,
} from '../../../src/modules/schedules/service';
import {
  createHarness,
  newClient,
  ownerQuery,
  seedTask,
  type Client,
  type Harness,
} from './support';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const weekly = {
  frequency: 'weekly',
  byWeekday: ['MO'],
  time: '09:00',
  timeZone: 'Europe/Berlin',
} as const;

async function create(
  c: Client,
  body: Record<string, unknown> = {},
  headers?: Record<string, string>,
) {
  return c.request(
    'POST',
    '/v1/schedules',
    {
      title: 'Monday digest',
      request: 'Summarize https://example.com/news and email it to me',
      recurrence: weekly,
      ...body,
    },
    headers,
  );
}

async function created(c: Client, body: Record<string, unknown> = {}): Promise<Schedule> {
  const res = await create(c, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Schedule>();
}

describe('create and read', () => {
  it('computes the RRULE and next run in the schedule zone', async () => {
    const c = await newClient(h);
    const s = await created(c);
    expect(s).toMatchObject({
      title: 'Monday digest',
      language: 'en',
      status: 'active',
      pausedReason: null,
      runCount: 0,
      consecutiveFailures: 0,
      createdBy: 'user',
      conversationId: null,
      lastRunAt: null,
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        byWeekday: ['MO'],
        time: '09:00',
        timeZone: 'Europe/Berlin',
      },
    });
    const next = new Date(s.nextRunAt!);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    // Monday 09:00 in Berlin.
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(next);
    expect(local).toBe('Mon 09:00');
    expect(s.rrule).toMatch(
      /^DTSTART;TZID=Europe\/Berlin:\d{8}T090000\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0$/,
    );

    const detail = (await c.request('GET', `/v1/schedules/${s.id}`)).json<ScheduleDetail>();
    expect(detail.upcoming).toHaveLength(SCHEDULE_LIMITS.upcomingShown);
    expect(detail.upcoming[0]).toBe(s.nextRunAt);
    expect(
      new Date(detail.upcoming[1]!).getTime() - new Date(detail.upcoming[0]!).getTime(),
    ).toBeGreaterThanOrEqual(7 * 86_400_000 - 3_600_000);
    expect(detail.runs).toEqual([]);
    const list = (await c.request('GET', '/v1/schedules')).json<{ items: Schedule[] }>();
    expect(list.items.map((x) => x.id)).toEqual([s.id]);

    // Audited without the request text; a schedule.changed event for the clients.
    const audits = await ownerQuery<{ action: string; metadata: Record<string, unknown> }>(
      'SELECT action, metadata FROM audit_events WHERE target_id = $1',
      [s.id],
    );
    expect(audits).toEqual([
      {
        action: 'schedule.created',
        metadata: { frequency: 'weekly', interval: 1, createdBy: 'user' },
      },
    ]);
  });

  it('stores time zones in the server spelling and refuses unknown ones', async () => {
    const c = await newClient(h);
    const s = await created(c, { recurrence: { ...weekly, timeZone: 'europe/berlin' } });
    expect(s.recurrence.timeZone).toBe('Europe/Berlin');
    for (const tz of ['Mars/Olympus', 'Europe/Berlin; drop table', 'posixrules']) {
      const res = await create(c, { recurrence: { ...weekly, timeZone: tz } });
      expect(res.statusCode, tz).toBe(400);
      expect(res.json().error.details.reason, tz).toBe('UNKNOWN_TIME_ZONE');
    }
  });

  it('validates the recurrence', async () => {
    const c = await newClient(h);
    const bad: Record<string, unknown>[] = [
      { frequency: 'weekly', time: '09:00', timeZone: 'UTC' }, // no weekday
      { frequency: 'daily', byWeekday: ['MO'], time: '09:00', timeZone: 'UTC' },
      { frequency: 'monthly', byMonthDay: [0], time: '09:00', timeZone: 'UTC' },
      { frequency: 'daily', time: '24:00', timeZone: 'UTC' },
      { frequency: 'daily', time: '9:00', timeZone: 'UTC' },
      { frequency: 'hourly', time: '09:00', timeZone: 'UTC' },
      { frequency: 'daily', time: '09:00', timeZone: 'UTC', until: '2030-01-01', count: 3 },
      { frequency: 'daily', time: '09:00', timeZone: 'UTC', interval: 13 },
    ];
    for (const recurrence of bad) {
      const res = await create(c, { recurrence });
      expect(res.statusCode, JSON.stringify(recurrence)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    }
    const past = await create(c, {
      recurrence: { frequency: 'daily', time: '09:00', timeZone: 'UTC', until: '2020-01-01' },
    });
    expect(past.statusCode).toBe(400);
    expect(past.json().error.details.reason).toBe('RECURRENCE_HAS_NO_OCCURRENCES');
    expect((await create(c, { title: '' })).statusCode).toBe(400);
    expect((await c.request('GET', '/v1/schedules')).json<{ items: Schedule[] }>().items).toEqual(
      [],
    );
  });

  it('is idempotent per Idempotency-Key', async () => {
    const c = await newClient(h);
    const a = await create(c, {}, { 'idempotency-key': 'schedule-key-0001' });
    const b = await create(c, {}, { 'idempotency-key': 'schedule-key-0001' });
    expect(a.statusCode).toBe(201);
    expect(b.json<Schedule>().id).toBe(a.json<Schedule>().id);
    expect(
      (await c.request('GET', '/v1/schedules')).json<{ items: Schedule[] }>().items,
    ).toHaveLength(1);
  });

  it(`caps schedules per user at ${SCHEDULE_LIMITS.maxPerUser}`, async () => {
    const c = await newClient(h);
    for (let i = 0; i < SCHEDULE_LIMITS.maxPerUser; i++) await created(c, { title: `S${i}` });
    const res = await create(c, { title: 'one too many' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toEqual({
      reason: 'SCHEDULE_LIMIT_REACHED',
      max: SCHEDULE_LIMITS.maxPerUser,
    });
  });
});

describe('preview', () => {
  it('returns the next occurrences and the canonical zone without saving', async () => {
    const c = await newClient(h);
    const res = await c.request('POST', '/v1/schedules/preview', {
      recurrence: { frequency: 'monthly', byMonthDay: [-1], time: '18:30', timeZone: 'asia/tokyo' },
      count: 4,
    });
    expect(res.statusCode, res.body).toBe(200);
    const p = res.json<SchedulePreview>();
    expect(p.timeZone).toBe('Asia/Tokyo');
    expect(p.occurrences).toHaveLength(4);
    for (const o of p.occurrences) {
      const d = new Date(o);
      // 18:30 in Tokyo = 09:30 UTC, on the last day of a month.
      expect(d.toISOString().slice(11, 16)).toBe('09:30');
      expect(new Date(d.getTime() + 15 * 3_600_000).getUTCDate()).toBe(1);
    }
    expect(p.rrule).toContain('BYMONTHDAY=-1');
    expect((await c.request('GET', '/v1/schedules')).json<{ items: Schedule[] }>().items).toEqual(
      [],
    );
    const ended = await c.request('POST', '/v1/schedules/preview', {
      recurrence: { frequency: 'daily', time: '09:00', timeZone: 'UTC', until: '2020-01-01' },
    });
    expect(ended.json<SchedulePreview>().occurrences).toEqual([]);
    const tooMany = await c.request('POST', '/v1/schedules/preview', {
      recurrence: { frequency: 'daily', time: '09:00', timeZone: 'UTC' },
      count: SCHEDULE_LIMITS.maxPreview + 1,
    });
    expect(tooMany.statusCode).toBe(400);
  });
});

describe('update, pause, resume, delete', () => {
  it('pauses (no next run) and resumes from the next occurrence', async () => {
    const c = await newClient(h);
    const s = await created(c);
    const paused = (await c.request('POST', `/v1/schedules/${s.id}/pause`)).json<Schedule>();
    expect(paused).toMatchObject({ status: 'paused', pausedReason: 'user', nextRunAt: null });
    expect(
      (await c.request('GET', `/v1/schedules/${s.id}`)).json<ScheduleDetail>().upcoming,
    ).toEqual([]);
    // Idempotent.
    expect((await c.request('POST', `/v1/schedules/${s.id}/pause`)).json<Schedule>().status).toBe(
      'paused',
    );
    const resumed = (await c.request('POST', `/v1/schedules/${s.id}/resume`)).json<Schedule>();
    expect(resumed).toMatchObject({ status: 'active', pausedReason: null, nextRunAt: s.nextRunAt });
  });

  it('updates the title, request and recurrence (next run recomputed)', async () => {
    const c = await newClient(h);
    const s = await created(c);
    const res = await c.request('PATCH', `/v1/schedules/${s.id}`, {
      title: 'Daily digest',
      request: 'Fasse https://example.com/news zusammen und schick es mir',
      recurrence: { frequency: 'daily', time: '07:15', timeZone: 'America/New_York' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const u = res.json<Schedule>();
    expect(u).toMatchObject({ title: 'Daily digest', language: 'de', status: 'active' });
    expect(u.recurrence).toEqual({
      frequency: 'daily',
      interval: 1,
      time: '07:15',
      timeZone: 'America/New_York',
    });
    expect(u.rrule).toContain('DTSTART;TZID=America/New_York:');
    expect(new Date(u.nextRunAt!).getTime() - Date.now()).toBeLessThanOrEqual(
      86_400_000 + 3_600_000,
    );
    // A paused schedule stays paused when its recurrence changes.
    await c.request('POST', `/v1/schedules/${s.id}/pause`);
    const p = (
      await c.request('PATCH', `/v1/schedules/${s.id}`, {
        recurrence: { frequency: 'daily', time: '08:00', timeZone: 'UTC' },
      })
    ).json<Schedule>();
    expect(p).toMatchObject({ status: 'paused', nextRunAt: null });
    expect(
      (
        await c.request('PATCH', `/v1/schedules/${s.id}`, {
          recurrence: { frequency: 'daily', time: '08:00', timeZone: 'Nowhere/City' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('answers 409 SCHEDULE_COMPLETED when a finished series is resumed', async () => {
    const c = await newClient(h);
    const s = await created(c, {
      recurrence: { frequency: 'daily', time: '09:00', timeZone: 'UTC', count: 1 },
    });
    // Run its only occurrence (as the scheduler would) while it is due.
    await withContext(h.db, c.user, (trx) =>
      trx
        .updateTable('scheduled_tasks')
        .set({ next_run_at: new Date(Date.now() - 1000) })
        .where('id', '=', s.id)
        .execute(),
    );
    const taskId = await seedTask(h.db, c.user, { status: 'COMPLETED' });
    const after = await withContext(h.db, c.user, async (trx) => {
      const due = await lockDueSchedule(trx, s.id, new Date());
      expect(due).not.toBeNull();
      return advanceSchedule(trx, c.user, due!, {
        occurrenceAt: new Date(s.nextRunAt!),
        taskId,
        now: new Date(s.nextRunAt!),
      });
    });
    expect(after).toMatchObject({
      status: 'completed',
      next_run_at: null,
      run_count: 1,
      last_task_id: taskId,
    });
    const res = await c.request('POST', `/v1/schedules/${s.id}/resume`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.reason).toBe('SCHEDULE_COMPLETED');
    expect((await c.request('POST', `/v1/schedules/${s.id}/pause`)).statusCode).toBe(409);
    // A new recurrence starts a new series and makes it active again.
    const again = (
      await c.request('PATCH', `/v1/schedules/${s.id}`, {
        recurrence: { frequency: 'daily', time: '10:00', timeZone: 'UTC' },
      })
    ).json<Schedule>();
    expect(again.status).toBe('active');
    expect(again.runCount).toBe(1);
  });

  it('pauses itself after repeated failed runs, and lists runs with their tasks', async () => {
    const c = await newClient(h);
    const s = await created(c);
    const taskId = await seedTask(h.db, c.user, { status: 'FAILED' });
    await withContext(h.db, c.user, (trx) =>
      trx
        .insertInto('schedule_runs')
        .values({
          tenant_id: c.user.tenantId,
          user_id: c.user.userId,
          schedule_id: s.id,
          occurrence_at: new Date(s.nextRunAt!),
          status: 'created',
          task_id: taskId,
        })
        .execute(),
    );
    for (let i = 1; i <= SCHEDULE_LIMITS.failuresBeforePause; i++) {
      const r = await withContext(h.db, c.user, (trx) =>
        recordScheduleRunResult(trx, c.user, s.id, 'failed'),
      );
      expect(r?.paused).toBe(i === SCHEDULE_LIMITS.failuresBeforePause);
    }
    const d = (await c.request('GET', `/v1/schedules/${s.id}`)).json<ScheduleDetail>();
    expect(d).toMatchObject({
      status: 'paused',
      pausedReason: 'failures',
      consecutiveFailures: 3,
      upcoming: [],
    });
    expect(d.runs).toEqual([
      expect.objectContaining({
        status: 'created',
        reason: null,
        task: expect.objectContaining({ id: taskId, status: 'FAILED' }),
      }),
    ]);
    const resumed = (await c.request('POST', `/v1/schedules/${s.id}/resume`)).json<Schedule>();
    expect(resumed).toMatchObject({ status: 'active', consecutiveFailures: 0 });
  });

  it('deletes a schedule (its tasks stay, unlinked)', async () => {
    const c = await newClient(h);
    const s = await created(c);
    const taskId = await seedTask(h.db, c.user, { status: 'COMPLETED' });
    await withContext(h.db, c.user, (trx) =>
      trx.updateTable('tasks').set({ schedule_id: s.id }).where('id', '=', taskId).execute(),
    );
    expect((await c.request('GET', `/v1/tasks/${taskId}`)).json().scheduleId).toBe(s.id);
    expect((await c.request('DELETE', `/v1/schedules/${s.id}`)).statusCode).toBe(204);
    expect((await c.request('GET', `/v1/schedules/${s.id}`)).statusCode).toBe(404);
    const task = (await c.request('GET', `/v1/tasks/${taskId}`)).json();
    expect(task.scheduleId).toBeNull();
    expect((await c.request('DELETE', `/v1/schedules/${s.id}`)).statusCode).toBe(404);
  });
});

describe('isolation', () => {
  it("hides other users' schedules (404) on every route", async () => {
    const owner = await newClient(h);
    const other = await newClient(h);
    const s = await created(owner);
    for (const [method, url, body] of [
      ['GET', `/v1/schedules/${s.id}`, undefined],
      ['PATCH', `/v1/schedules/${s.id}`, { title: 'mine now' }],
      ['DELETE', `/v1/schedules/${s.id}`, undefined],
      ['POST', `/v1/schedules/${s.id}/pause`, undefined],
      ['POST', `/v1/schedules/${s.id}/resume`, undefined],
    ] as const) {
      const res = await other.request(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(
      (await other.request('GET', '/v1/schedules')).json<{ items: Schedule[] }>().items,
    ).toEqual([]);
    expect((await owner.request('GET', `/v1/schedules/${s.id}`)).json<Schedule>().title).toBe(
      'Monday digest',
    );
  });
});
