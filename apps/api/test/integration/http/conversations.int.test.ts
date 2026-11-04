import { access } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Attachment,
  ConversationDetail,
  ConversationSummary,
  TaskSummary,
} from '@jarvis/contracts';
import { withContext } from '../../../src/db/pool';
import { fileUpload } from './multipart';
import { createHarness, newClient, type Client, type Harness } from './support';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

type Page = { items: ConversationSummary[]; nextCursor: string | null };

async function start(c: Client, request: string): Promise<TaskSummary> {
  const res = await c.request('POST', '/v1/tasks', { request });
  expect(res.statusCode).toBe(202);
  return res.json<TaskSummary>();
}

/** Completes a task the way the runtime does: status + outcome in one update, then JARVIS's message. */
async function complete(
  c: Client,
  task: TaskSummary,
  opts: { outcome?: 'answer' | 'action' | 'question'; text?: string } = {},
) {
  const outcome = opts.outcome ?? 'answer';
  const text = opts.text ?? 'Here is the answer.';
  await withContext(h.db, c.user, async (trx) => {
    await trx
      .updateTable('tasks')
      .set({
        status: 'COMPLETED',
        completed_at: new Date(),
        outcome,
        result_summary: text,
        question:
          outcome === 'question'
            ? JSON.stringify({
                text,
                message: { key: 'question.emailContent', params: {} },
                missing: ['email_content'],
              })
            : null,
      })
      .where('id', '=', task.id)
      .execute();
    await trx
      .insertInto('messages')
      .values({
        tenant_id: c.user.tenantId,
        user_id: c.user.userId,
        conversation_id: task.conversationId!,
        task_id: task.id,
        role: 'assistant',
        kind: outcome === 'question' ? 'question' : 'answer',
        content: text,
        language: 'en',
      })
      .execute();
  });
}

async function detail(c: Client, id: string, qs = ''): Promise<ConversationDetail> {
  const res = await c.request('GET', `/v1/conversations/${id}${qs}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<ConversationDetail>();
}

describe('conversation thread', () => {
  it('shows request → task → JARVIS message per task, and gates follow-ups on activity', async () => {
    const c = await newClient(h);
    const first = await start(c, 'What is the capital of France?');
    expect(first.conversationId).toBeDefined();
    const convId = first.conversationId!;

    let d = await detail(c, convId);
    expect(d).toMatchObject({
      id: convId,
      taskCount: 1,
      hasActiveTask: true,
      canFollowUp: false,
      activeTaskId: first.id,
      scheduleId: null,
      earlierCursor: null,
    });
    expect(d.turns.map((t) => t.type)).toEqual(['user_message', 'task']);

    // A follow-up while a task is active is refused with the task to wait for.
    const busy = await c.request('POST', `/v1/conversations/${convId}/messages`, {
      request: 'And Germany?',
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'CONVERSATION_BUSY', taskId: first.id },
    });

    await complete(c, first, { text: 'Paris.' });
    d = await detail(c, convId);
    expect(d.canFollowUp).toBe(true);
    expect(d.activeTaskId).toBeNull();
    expect(d.turns.map((t) => t.type)).toEqual(['user_message', 'task', 'assistant_message']);
    const answer = d.turns[2]!;
    expect(answer.type === 'assistant_message' && answer.message).toMatchObject({
      role: 'assistant',
      kind: 'answer',
      text: 'Paris.',
      taskId: first.id,
      language: 'en',
      attachments: [],
    });
    const task = d.turns[1]!;
    expect(task.type === 'task' && task.task).toMatchObject({
      id: first.id,
      status: 'COMPLETED',
      outcome: 'answer',
    });

    // Follow-up: a new task in the same conversation, after the first.
    const res = await c.request('POST', `/v1/conversations/${convId}/messages`, {
      request: 'And Germany?',
    });
    expect(res.statusCode).toBe(202);
    const second = res.json<TaskSummary>();
    expect(second).toMatchObject({
      conversationId: convId,
      status: 'QUEUED',
      request: 'And Germany?',
    });
    expect(h.fake.calls.followUp.at(-1)).toMatchObject({ conversationId: convId });

    d = await detail(c, convId);
    expect(d.taskCount).toBe(2);
    expect(d.lastTask?.id).toBe(second.id);
    expect(d.turns.map((t) => (t.type === 'task' ? `task:${t.task.id}` : t.type))).toEqual([
      'user_message',
      `task:${first.id}`,
      'assistant_message',
      'user_message',
      `task:${second.id}`,
    ]);
  });

  it('renders a clarifying question with its server message', async () => {
    const c = await newClient(h);
    const t = await start(c, 'email me');
    await complete(c, t, { outcome: 'question', text: 'What should the email say?' });
    const d = await detail(c, t.conversationId!);
    const task = d.turns.find((x) => x.type === 'task');
    expect(task?.type === 'task' && task.task).toMatchObject({
      outcome: 'question',
      question: {
        text: 'What should the email say?',
        message: { key: 'question.emailContent', params: {} },
        missing: ['email_content'],
      },
    });
    expect(d.turns.at(-1)).toMatchObject({
      type: 'assistant_message',
      message: { kind: 'question' },
    });
  });

  it('pages a long thread from the newest tasks backwards', async () => {
    const c = await newClient(h);
    const t1 = await start(c, 'one');
    await complete(c, t1);
    const convId = t1.conversationId!;
    const ids = [t1.id];
    for (const r of ['two', 'three']) {
      const res = await c.request('POST', `/v1/conversations/${convId}/messages`, { request: r });
      const t = res.json<TaskSummary>();
      await complete(c, t);
      ids.push(t.id);
    }
    const page1 = await detail(c, convId, '?limit=2');
    const taskIds = (d: ConversationDetail) =>
      d.turns.flatMap((t) => (t.type === 'task' ? [t.task.id] : []));
    expect(taskIds(page1)).toEqual([ids[1], ids[2]]);
    expect(page1.earlierCursor).not.toBeNull();
    const page2 = await detail(
      c,
      convId,
      `?limit=2&before=${encodeURIComponent(page1.earlierCursor!)}`,
    );
    expect(taskIds(page2)).toEqual([ids[0]]);
    expect(page2.earlierCursor).toBeNull();
    expect((await c.request('GET', `/v1/conversations/${convId}?before=garbage`)).statusCode).toBe(
      400,
    );
  });

  it('shows the files attached to each request', async () => {
    const c = await newClient(h);
    const { payload, headers } = fileUpload('notes.txt', 'meeting notes');
    const a = (await c.request('POST', '/v1/attachments', payload, headers)).json<Attachment>();
    const t = await start(c, 'Plain request');
    await complete(c, t);
    const res = await c.request('POST', `/v1/conversations/${t.conversationId}/messages`, {
      request: 'Summarise this file',
      attachmentIds: [a.id],
    });
    expect(res.statusCode, res.body).toBe(202);
    const d = await detail(c, t.conversationId!);
    const userTurns = d.turns.filter((x) => x.type === 'user_message');
    expect(
      userTurns.map((x) => x.type === 'user_message' && x.message.attachments.map((f) => f.id)),
    ).toEqual([[], [a.id]]);
  });

  it('replays an idempotent follow-up', async () => {
    const c = await newClient(h);
    const t = await start(c, 'Initial');
    await complete(c, t);
    const send = () =>
      c.request(
        'POST',
        `/v1/conversations/${t.conversationId}/messages`,
        { request: 'Again' },
        {
          'idempotency-key': 'follow-up-key-1',
        },
      );
    const a = (await send()).json<TaskSummary>();
    const b = (await send()).json<TaskSummary>();
    expect(b.id).toBe(a.id);
  });
});

describe('history list', () => {
  it('lists most recent activity first, with paging and search', async () => {
    const c = await newClient(h);
    const a = await start(c, 'Plan a trip to Lisbon');
    await complete(c, a);
    const b = await start(c, 'Discount of 100% on shoes?');
    await complete(c, b);
    const cTask = await start(c, 'Weather in Berlin');

    let page = (await c.request('GET', '/v1/conversations?limit=2')).json<Page>();
    expect(page.items.map((i) => i.id)).toEqual([cTask.conversationId, b.conversationId]);
    expect(page.items[0]).toMatchObject({
      taskCount: 1,
      hasActiveTask: true,
      lastTask: { id: cTask.id },
    });
    expect(page.items[1]).toMatchObject({
      hasActiveTask: false,
      lastTask: { status: 'COMPLETED' },
    });
    page = (
      await c.request(
        'GET',
        `/v1/conversations?limit=2&cursor=${encodeURIComponent(page.nextCursor!)}`,
      )
    ).json<Page>();
    expect(page.items.map((i) => i.id)).toEqual([a.conversationId]);
    expect(page.nextCursor).toBeNull();

    // A follow-up moves its conversation to the top.
    await c.request('POST', `/v1/conversations/${a.conversationId}/messages`, {
      request: 'Add hotels',
    });
    page = (await c.request('GET', '/v1/conversations')).json<Page>();
    expect(page.items[0]!.id).toBe(a.conversationId);
    expect(page.items[0]!.taskCount).toBe(2);

    const search = async (q: string) =>
      (await c.request('GET', `/v1/conversations?q=${encodeURIComponent(q)}`))
        .json<Page>()
        .items.map((i) => i.id);
    expect(await search('lisbon')).toEqual([a.conversationId]);
    expect(await search('hotels')).toEqual([a.conversationId]); // a later request matches too
    expect(await search('100%')).toEqual([b.conversationId]); // wildcards are literal
    expect(await search('%')).toEqual([b.conversationId]);
    expect(await search('nothing like this')).toEqual([]);
  });

  it('marks the conversation that collects a schedule', async () => {
    const c = await newClient(h);
    const t = await start(c, 'Daily digest');
    const scheduleId = await withContext(h.db, c.user, async (trx) => {
      const row = await trx
        .insertInto('scheduled_tasks')
        .values({
          tenant_id: c.user.tenantId,
          user_id: c.user.userId,
          title: 'Digest',
          request: 'Daily digest',
          rrule:
            'DTSTART;TZID=UTC:20261105T090000\nRRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
          time_zone: 'UTC',
          recurrence: JSON.stringify({
            frequency: 'daily',
            interval: 1,
            time: '09:00',
            timeZone: 'UTC',
          }),
          next_run_at: new Date(Date.now() + 86_400_000),
          conversation_id: t.conversationId!,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    const page = (await c.request('GET', '/v1/conversations')).json<Page>();
    expect(page.items.find((i) => i.id === t.conversationId)?.scheduleId).toBe(scheduleId);
  });
});

describe('delete', () => {
  it('refuses while a task is active, then deletes tasks, messages and files', async () => {
    const c = await newClient(h);
    const { payload, headers } = fileUpload('keep.txt', 'attached file');
    const a = (await c.request('POST', '/v1/attachments', payload, headers)).json<Attachment>();
    const t = (
      await c.request('POST', '/v1/tasks', { request: 'Read this', attachmentIds: [a.id] })
    ).json<TaskSummary>();
    const convId = t.conversationId!;

    const blocked = await c.request('DELETE', `/v1/conversations/${convId}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.details).toEqual({
      reason: 'CONVERSATION_ACTIVE_TASK',
      taskId: t.id,
    });

    await complete(c, t);
    const key = (
      await withContext(h.db, c.user, (trx) =>
        trx
          .selectFrom('attachments')
          .select('storage_key')
          .where('id', '=', a.id)
          .executeTakeFirstOrThrow(),
      )
    ).storage_key;
    const file = path.join(h.storageDir!, ...key.split('/'));
    await access(file);

    expect((await c.request('DELETE', `/v1/conversations/${convId}`)).statusCode).toBe(204);
    expect((await c.request('GET', `/v1/conversations/${convId}`)).statusCode).toBe(404);
    expect((await c.request('GET', `/v1/tasks/${t.id}`)).statusCode).toBe(404);
    expect((await c.request('GET', `/v1/attachments/${a.id}`)).statusCode).toBe(404);
    await expect(access(file)).rejects.toThrow();
    const left = await withContext(h.db, c.user, (trx) =>
      trx.selectFrom('messages').select('id').where('conversation_id', '=', convId).execute(),
    );
    expect(left).toEqual([]);
    expect((await c.request('DELETE', `/v1/conversations/${convId}`)).statusCode).toBe(404);
  });
});

describe('isolation', () => {
  it("hides other users' conversations (404) on every route", async () => {
    const owner = await newClient(h);
    const other = await newClient(h);
    const t = await start(owner, 'Private thoughts');
    await complete(owner, t);
    const id = t.conversationId!;
    expect((await other.request('GET', `/v1/conversations/${id}`)).statusCode).toBe(404);
    expect((await other.request('DELETE', `/v1/conversations/${id}`)).statusCode).toBe(404);
    const fu = await other.request('POST', `/v1/conversations/${id}/messages`, {
      request: 'hijack',
    });
    expect(fu.statusCode).toBe(404);
    expect((await other.request('GET', '/v1/conversations')).json<Page>().items).toEqual([]);
    // The owner's thread is untouched.
    expect((await detail(owner, id)).taskCount).toBe(1);
  });

  it('validates input', async () => {
    const c = await newClient(h);
    expect((await c.request('GET', '/v1/conversations/nope')).statusCode).toBe(400);
    expect((await c.request('GET', '/v1/conversations?limit=500')).statusCode).toBe(400);
    const t = await start(c, 'x');
    await complete(c, t);
    expect(
      (await c.request('POST', `/v1/conversations/${t.conversationId}/messages`, { request: '' }))
        .statusCode,
    ).toBe(400);
  });
});
