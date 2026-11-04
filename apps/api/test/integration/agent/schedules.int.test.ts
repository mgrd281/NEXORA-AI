/**
 * Scheduled tasks end to end:
 *  - the offline planner proposes a schedule; creating it needs approval
 *    (FUTURE_RUNS) showing the exact request, recurrence and next runs;
 *  - each occurrence creates exactly one task, also with two workers racing
 *    and duplicate jobs, and next_run_at advances in Europe/Berlin across the
 *    end of summer time (2025-10-26: 09:00 is 07:00Z before, 08:00Z after);
 *  - a scheduled run is planned and approved like any task (the approval
 *    notifies the user); failed runs notify (schedule_failed) and pause the
 *    schedule after three in a row; an exhausted budget pauses it; a job that
 *    cannot create the task records a failed run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateScheduleRequest } from '@jarvis/contracts';
import { withContext, type DbContext } from '../../../src/db/pool';
import type { JobRow } from '../../../src/db/types';
import { onJobDead } from '../../../src/modules/agent/jobs';
import { schedulerTick } from '../../../src/modules/agent/jobs/schedule-run';
import { enqueue } from '../../../src/modules/jobs/queue';
import { insertSchedule } from '../../../src/modules/schedules/service';
import { runOnce, type WorkerDeps } from '../../../src/worker';
import {
  connectSmtp,
  connectWeb,
  createHarness,
  detail,
  drain,
  newUser,
  secondWorker,
  type Harness,
} from './harness';

let clock = new Date();
let h: Harness;
beforeAll(async () => {
  h = await createHarness({ now: () => clock });
});
afterAll(() => h.close());

async function berlinUser(prefs: Parameters<typeof newUser>[1] = {}) {
  const user = await newUser(h.db, prefs);
  await withContext(h.db, user, (trx) =>
    trx
      .updateTable('users')
      .set({ time_zone: 'Europe/Berlin' })
      .where('id', '=', user.userId)
      .execute(),
  );
  return user;
}

async function schedule(
  user: DbContext,
  request: string,
  recurrence: Partial<CreateScheduleRequest['recurrence']> = {},
  createdAt = new Date('2025-10-24T00:00:00Z'),
) {
  return withContext(h.db, user, (trx) =>
    insertSchedule(
      trx,
      user,
      {
        title: 'Daily note',
        request,
        recurrence: {
          frequency: 'daily',
          interval: 1,
          time: '09:00',
          timeZone: 'Europe/Berlin',
          ...recurrence,
        },
      },
      { createdBy: 'user', now: createdAt },
    ),
  );
}

async function scheduleRow(user: DbContext, id: string) {
  return withContext(h.db, user, (trx) =>
    trx.selectFrom('scheduled_tasks').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
  );
}

async function runs(user: DbContext, id: string) {
  return withContext(h.db, user, (trx) =>
    trx
      .selectFrom('schedule_runs')
      .select(['occurrence_at', 'status', 'reason', 'task_id'])
      .where('schedule_id', '=', id)
      .orderBy('occurrence_at')
      .execute(),
  );
}

async function notifications(user: DbContext) {
  return withContext(h.db, user, (trx) =>
    trx
      .selectFrom('notifications')
      .select(['kind', 'data', 'task_id'])
      .orderBy('created_at')
      .execute(),
  );
}

/** One scheduler tick, then every due job, with the clock at `at`. */
async function runAt(at: string, workers: WorkerDeps[] = [h.worker]) {
  clock = new Date(at);
  await schedulerTick(h.worker);
  await drain(workers[0]!);
}

describe('agent-proposed schedules', () => {
  it('"every Monday at 9 …" needs approval of the exact request and next runs, then is stored', async () => {
    const user = await berlinUser();
    await connectWeb(h.db, user);
    await connectSmtp(h.db, h.secrets, user, h.smtp.port);
    const url = h.site.url('/article');
    const s = await h.services.tasks.create(
      user,
      { request: `every Monday at 9 summarize ${url} and email it to me`, source: 'text' },
      {},
    );
    await drain(h.worker);
    const waiting = await detail(h.db, user, s.id);
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    expect(waiting.steps.map((x) => x.toolId)).toEqual(['schedule.create']);
    const approval = waiting.approvals[0]!;
    expect(approval.reasons).toEqual(['RISK_MEDIUM', 'FUTURE_RUNS']);
    expect(approval.summaryMessage?.key).toBe('approval.schedule');
    if (approval.details.kind !== 'schedule') throw new Error('expected schedule details');
    expect(approval.details.request).toBe(`Summarize ${url} and email it to me`);
    expect(approval.details.recurrence).toMatchObject({
      frequency: 'weekly',
      byWeekday: ['MO'],
      time: '09:00',
      timeZone: 'Europe/Berlin',
    });
    expect(approval.details.rrule).toContain('RRULE:FREQ=WEEKLY');
    expect(approval.details.nextOccurrences).toHaveLength(3);
    for (const at of approval.details.nextOccurrences) {
      const local = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Berlin',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(at));
      expect(local).toBe('Mon 09:00');
    }
    // Nothing exists before the user approves.
    expect(
      await withContext(h.db, user, (trx) =>
        trx.selectFrom('scheduled_tasks').select('id').execute(),
      ),
    ).toEqual([]);
    await h.services.approvals.decide(
      user,
      approval.id,
      { decision: 'approve', actionHash: approval.actionHash },
      'web',
    );
    await drain(h.worker);
    const done = await detail(h.db, user, s.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.outcome).toBe('action');
    expect(done.resultSummaryMessage?.key).toBe('result.scheduleCreated');
    const stored = await withContext(h.db, user, (trx) =>
      trx.selectFrom('scheduled_tasks').selectAll().execute(),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      created_by: 'agent',
      created_by_task_id: s.id,
      status: 'active',
      request: `Summarize ${url} and email it to me`,
    });
    expect(done.evidence.map((e) => e.code)).toEqual(['SCHEDULE_RECORD']);
  });
});

describe('runs: exactly once per occurrence', () => {
  it('two workers racing on duplicate jobs create one task, and next_run_at follows Berlin time across DST', async () => {
    const user = await berlinUser();
    const created = await schedule(user, 'remember that the daily schedule ran');
    expect(created.next_run_at?.toISOString()).toBe('2025-10-24T07:00:00.000Z'); // Fri 09:00 CEST
    const other = secondWorker(h);
    clock = new Date('2025-10-24T07:00:05Z');

    // Both workers tick at once (one job: deduplicated), plus a duplicate job with
    // another key, as a late second tick would produce — then both drain concurrently.
    await Promise.all([schedulerTick(h.worker), schedulerTick(other)]);
    await h.db.transaction().execute((trx) =>
      enqueue(trx, {
        kind: 'schedule.run',
        tenantId: user.tenantId,
        userId: user.userId,
        payload: { scheduleId: created.id },
        dedupeKey: `duplicate:${created.id}`,
      }),
    );
    const jobs = await h.db
      .selectFrom('jobs')
      .select('id')
      .where('kind', '=', 'schedule.run')
      .where('user_id', '=', user.userId)
      .execute();
    expect(jobs).toHaveLength(2);
    await Promise.all([runOnce(h.worker, { limit: 1 }), runOnce(other, { limit: 1 })]);
    await drain(h.worker);
    await drain(other);

    let row = await scheduleRow(user, created.id);
    expect(row.run_count).toBe(1);
    expect(row.next_run_at?.toISOString()).toBe('2025-10-25T07:00:00.000Z'); // Sat 09:00 CEST
    const first = await runs(user, created.id);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: 'created', reason: null });
    const task = await detail(h.db, user, first[0]!.task_id!);
    expect(task).toMatchObject({ source: 'schedule', scheduleId: created.id, status: 'COMPLETED' });
    expect(task.conversationId).toBe(row.conversation_id);

    await runAt('2025-10-25T07:00:03Z');
    row = await scheduleRow(user, created.id);
    expect(row.next_run_at?.toISOString()).toBe('2025-10-26T08:00:00.000Z'); // Sun 09:00 CET
    await runAt('2025-10-26T08:00:01Z');
    row = await scheduleRow(user, created.id);
    expect(row.next_run_at?.toISOString()).toBe('2025-10-27T08:00:00.000Z');
    expect(row.run_count).toBe(3);
    const all = await runs(user, created.id);
    expect(all.map((r) => r.occurrence_at.toISOString())).toEqual([
      '2025-10-24T07:00:00.000Z',
      '2025-10-25T07:00:00.000Z',
      '2025-10-26T08:00:00.000Z',
    ]);
    // All runs collect in the schedule's one conversation.
    const tasks = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('tasks')
        .select(['conversation_id', 'idempotency_key'])
        .where('schedule_id', '=', created.id)
        .execute(),
    );
    expect(new Set(tasks.map((t) => t.conversation_id))).toEqual(new Set([row.conversation_id]));
    expect(tasks.map((t) => t.idempotency_key).sort()).toEqual(
      all.map((r) => `schedule:${created.id}:${r.occurrence_at.toISOString()}`).sort(),
    );

    // Running again at the same instant changes nothing (not due).
    await runAt('2025-10-26T08:00:02Z');
    expect(await runs(user, created.id)).toHaveLength(3);
  });

  it('a missed stretch collapses into one run, then continues from now', async () => {
    const user = await berlinUser();
    const created = await schedule(user, 'remember that a late run happened');
    await runAt('2025-10-29T12:00:00Z'); // five occurrences missed
    const all = await runs(user, created.id);
    expect(all).toHaveLength(1);
    expect((await scheduleRow(user, created.id)).next_run_at?.toISOString()).toBe(
      '2025-10-30T08:00:00.000Z',
    );
  });
});

describe('runs are ordinary tasks', () => {
  it('an approval a run needs notifies the user', async () => {
    const user = await berlinUser();
    await connectSmtp(h.db, h.secrets, user, h.smtp.port);
    const created = await schedule(user, 'email me: water the plants');
    await runAt('2025-10-24T07:00:01Z');
    const [run] = await runs(user, created.id);
    const task = await detail(h.db, user, run!.task_id!);
    expect(task.status).toBe('AWAITING_APPROVAL');
    const kinds = (await notifications(user)).map((n) => n.kind);
    expect(kinds).toContain('approval_requested');
  });

  it('failed runs notify and pause the schedule after three in a row', async () => {
    const user = await berlinUser();
    const created = await schedule(user, 'tell me a joke');
    for (const day of ['24', '25']) {
      await runAt(`2025-10-${day}T07:00:01Z`);
      expect((await scheduleRow(user, created.id)).status).toBe('active');
    }
    await runAt('2025-10-26T08:00:01Z');
    const row = await scheduleRow(user, created.id);
    expect(row).toMatchObject({
      status: 'paused',
      paused_reason: 'failures',
      consecutive_failures: 3,
      next_run_at: null,
    });
    const n = await notifications(user);
    expect(n.filter((x) => x.kind === 'schedule_failed')).toHaveLength(3);
    // One notification per failure: schedule_failed replaces task_failed for runs.
    expect(n.filter((x) => x.kind === 'task_failed')).toHaveLength(0);
    expect(n.filter((x) => x.kind === 'schedule_failed')[0]!.data).toMatchObject({
      scheduleTitle: 'Daily note',
      errorCode: 'PLANNER_UNSUPPORTED',
    });
    expect(n.filter((x) => x.kind === 'schedule_paused').map((x) => x.data)).toEqual([
      { scheduleTitle: 'Daily note', reason: 'failures' },
    ]);
    // Paused: nothing more runs.
    await runAt('2025-10-27T08:00:01Z');
    expect(await runs(user, created.id)).toHaveLength(3);
  });

  it('a successful run resets the failure count', async () => {
    const user = await berlinUser();
    const created = await schedule(user, 'remember that it worked');
    await withContext(h.db, user, (trx) =>
      trx
        .updateTable('scheduled_tasks')
        .set({ consecutive_failures: 2 })
        .where('id', '=', created.id)
        .execute(),
    );
    await runAt('2025-10-24T07:00:01Z');
    expect((await scheduleRow(user, created.id)).consecutive_failures).toBe(0);
  });

  it('a job that cannot create its task records a failed run and moves on', async () => {
    const user = await berlinUser();
    const created = await schedule(user, 'remember that this never runs');
    clock = new Date('2025-10-24T07:00:01Z');
    const job = {
      id: 0,
      kind: 'schedule.run',
      tenant_id: user.tenantId,
      user_id: user.userId,
      task_id: null,
      payload: { scheduleId: created.id },
    } as unknown as JobRow;
    await onJobDead(h.worker, job);
    expect(await runs(user, created.id)).toEqual([
      {
        occurrence_at: new Date('2025-10-24T07:00:00Z'),
        status: 'failed',
        reason: 'CREATE_FAILED',
        task_id: null,
      },
    ]);
    const row = await scheduleRow(user, created.id);
    expect(row).toMatchObject({ consecutive_failures: 1, status: 'active' });
    expect(row.next_run_at?.toISOString()).toBe('2025-10-25T07:00:00.000Z');
    expect((await notifications(user)).map((n) => n.kind)).toEqual(['schedule_failed']);
  });
});

describe('budget', () => {
  it('pauses a schedule whose runs the AI budget no longer pays for', async () => {
    const hk = await createHarness({
      env: { ANTHROPIC_API_KEY: 'sk-test-not-used' },
      now: () => clock,
    });
    try {
      const user = await newUser(hk.db, { spending: { monthlyAiBudgetUsd: 1 } });
      await withContext(hk.db, user, async (trx) => {
        await trx
          .updateTable('users')
          .set({ time_zone: 'Europe/Berlin' })
          .where('id', '=', user.userId)
          .execute();
        await trx
          .insertInto('cost_records')
          .values({
            tenant_id: user.tenantId,
            user_id: user.userId,
            category: 'model',
            amount_micro: 1_000_000,
          })
          .execute();
      });
      const created = await withContext(hk.db, user, (trx) =>
        insertSchedule(
          trx,
          user,
          {
            title: 'Daily note',
            request: 'remember that budget',
            recurrence: {
              frequency: 'daily',
              interval: 1,
              time: '09:00',
              timeZone: 'Europe/Berlin',
            },
          },
          { createdBy: 'user', now: new Date('2025-10-24T00:00:00Z') },
        ),
      );
      clock = new Date('2025-10-24T07:00:01Z');
      await schedulerTick(hk.worker);
      await drain(hk.worker);
      const row = await withContext(hk.db, user, (trx) =>
        trx
          .selectFrom('scheduled_tasks')
          .selectAll()
          .where('id', '=', created.id)
          .executeTakeFirstOrThrow(),
      );
      expect(row).toMatchObject({ status: 'paused', paused_reason: 'budget' });
      const r = await withContext(hk.db, user, (trx) =>
        trx.selectFrom('schedule_runs').select(['status', 'reason', 'task_id']).execute(),
      );
      expect(r).toEqual([{ status: 'skipped', reason: 'BUDGET_EXHAUSTED', task_id: null }]);
      const n = await withContext(hk.db, user, (trx) =>
        trx.selectFrom('notifications').select(['kind', 'data']).execute(),
      );
      expect(n).toEqual([
        { kind: 'schedule_paused', data: { scheduleTitle: 'Daily note', reason: 'budget' } },
      ]);
    } finally {
      await hk.close();
    }
  });
});
