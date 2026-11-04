/**
 * Conversation read model (docs/architecture/phase-b.md §3.1): the history
 * list and the thread view. Everything is read through RLS in the caller's
 * transaction; tasks render with the shared task-summary mapper, so a task
 * looks the same in the thread, the task list and the task detail.
 */
import { sql } from 'kysely';
import {
  ACTIVE_STATUSES,
  type ConversationDetail,
  type ConversationDetailQuery,
  type ConversationListQuery,
  type ConversationMessage,
  type ConversationSummary,
  type ConversationTurn,
  type TaskSummary,
} from '@jarvis/contracts';
import type { Trx } from '../../db/pool';
import type { MessageRow } from '../../db/types';
import { asLocale, asMessage } from '../agent/i18n';
import { loadTaskAttachments } from '../attachments/mappers';
import { afterCursor, cursorTimestamp, decodeCursor, encodeCursor, toPage } from '../home/cursor';
import { escapeLike } from '../memory/routes';
import { taskSummaryQuery, toTaskSummary, type TaskAggregate } from '../tasks/mappers';

const ACTIVE = [...ACTIVE_STATUSES];

interface ConversationAggregate {
  id: string;
  title: string;
  title_message: unknown;
  created_at: Date;
  updated_at: Date;
  task_count: number | null;
  last_task_id: string | null;
  active_task_id: string | null;
  schedule_id: string | null;
}

/** Conversations with their counters, newest task and active task (subqueries per row). */
function conversationQuery(trx: Trx) {
  return trx
    .selectFrom('conversations as c')
    .select(['c.id', 'c.title', 'c.title_message', 'c.created_at', 'c.updated_at'])
    .select((eb) => [
      eb
        .selectFrom('tasks as t')
        .whereRef('t.conversation_id', '=', 'c.id')
        .select(eb.fn.countAll<number>().as('n'))
        .as('task_count'),
      eb
        .selectFrom('tasks as t')
        .whereRef('t.conversation_id', '=', 'c.id')
        .orderBy('t.created_at', 'desc')
        .orderBy('t.id', 'desc')
        .select('t.id')
        .limit(1)
        .as('last_task_id'),
      eb
        .selectFrom('tasks as t')
        .whereRef('t.conversation_id', '=', 'c.id')
        .where('t.status', 'in', ACTIVE)
        .orderBy('t.created_at', 'desc')
        .orderBy('t.id', 'desc')
        .select('t.id')
        .limit(1)
        .as('active_task_id'),
      eb
        .selectFrom('scheduled_tasks as s')
        .whereRef('s.conversation_id', '=', 'c.id')
        .orderBy('s.created_at')
        .select('s.id')
        .limit(1)
        .as('schedule_id'),
    ]);
}

async function taskSummaries(trx: Trx, ids: readonly string[]): Promise<Map<string, TaskSummary>> {
  if (ids.length === 0) return new Map();
  const rows = (await taskSummaryQuery(trx)
    .where('t.id', 'in', [...ids])
    .execute()) as TaskAggregate[];
  return new Map(rows.map((r) => [r.id, toTaskSummary(r)]));
}

function toSummary(c: ConversationAggregate, lastTask: TaskSummary | null): ConversationSummary {
  return {
    id: c.id,
    title: c.title,
    titleMessage: asMessage(c.title_message),
    taskCount: Number(c.task_count ?? 0),
    lastTask,
    hasActiveTask: c.active_task_id !== null,
    scheduleId: c.schedule_id,
    createdAt: c.created_at.toISOString(),
    updatedAt: c.updated_at.toISOString(),
  };
}

/** History: most recent activity first (keyset on updated_at, id); `q` matches titles and requests. */
export async function listConversations(
  trx: Trx,
  userId: string,
  query: ConversationListQuery,
): Promise<{ items: ConversationSummary[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const q = query.q?.trim() || null;
  let b = conversationQuery(trx)
    .select(cursorTimestamp('c.updated_at').as('cursor_ts'))
    .where('c.user_id', '=', userId);
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    b = b.where((eb) =>
      eb.or([
        eb('c.title', 'ilike', pattern),
        eb.exists(
          eb
            .selectFrom('tasks as t')
            .select(sql`1`.as('one'))
            .whereRef('t.conversation_id', '=', 'c.id')
            .where((w) => w.or([w('t.request', 'ilike', pattern), w('t.title', 'ilike', pattern)])),
        ),
      ]),
    );
  }
  if (cursor) b = b.where(afterCursor('c.updated_at', 'c.id', cursor));
  const rows = (await b
    .orderBy('c.updated_at', 'desc')
    .orderBy('c.id', 'desc')
    .limit(query.limit + 1)
    .execute()) as (ConversationAggregate & { cursor_ts: string })[];
  const page = rows.slice(0, query.limit);
  const tasks = await taskSummaries(
    trx,
    page.map((r) => r.last_task_id).filter((id): id is string => !!id),
  );
  return toPage(rows, query.limit, (r) =>
    toSummary(r, r.last_task_id ? (tasks.get(r.last_task_id) ?? null) : null),
  );
}

function toMessage(
  m: Pick<
    MessageRow,
    'id' | 'role' | 'kind' | 'content' | 'content_message' | 'language' | 'task_id' | 'created_at'
  >,
  attachments: ConversationMessage['attachments'],
): ConversationMessage {
  return {
    id: m.id,
    role: m.role === 'assistant' ? 'assistant' : 'user',
    kind: m.kind,
    text: m.content,
    textMessage: asMessage(m.content_message),
    language: m.language && asLocale(m.language, 'en') === m.language ? asLocale(m.language) : null,
    taskId: m.task_id,
    attachments,
    createdAt: m.created_at.toISOString(),
  };
}

/**
 * A thread: the newest `limit` tasks (before the cursor), oldest first, each
 * as user request → task → JARVIS's message (once it completed).
 */
export async function loadConversation(
  trx: Trx,
  conversationId: string,
  query: ConversationDetailQuery,
): Promise<ConversationDetail | null> {
  const conv = (await conversationQuery(trx)
    .where('c.id', '=', conversationId)
    .executeTakeFirst()) as ConversationAggregate | undefined;
  if (!conv) return null;

  const before = query.before ? decodeCursor(query.before) : null;
  let tq = trx
    .selectFrom('tasks as t')
    .select(['t.id'])
    .select(cursorTimestamp('t.created_at').as('cursor_ts'))
    .where('t.conversation_id', '=', conversationId);
  if (before) tq = tq.where(afterCursor('t.created_at', 't.id', before));
  const newest = await tq
    .orderBy('t.created_at', 'desc')
    .orderBy('t.id', 'desc')
    .limit(query.limit + 1)
    .execute();
  const hasEarlier = newest.length > query.limit;
  const pageTasks = newest.slice(0, query.limit);
  const oldestOnPage = pageTasks[pageTasks.length - 1];
  const taskIds = pageTasks.map((t) => t.id);

  const [summaries, attachments, messages] = await Promise.all([
    taskSummaries(trx, [
      ...new Set([...taskIds, ...(conv.last_task_id ? [conv.last_task_id] : [])]),
    ]),
    loadTaskAttachments(trx, taskIds),
    taskIds.length
      ? trx
          .selectFrom('messages')
          .select([
            'id',
            'role',
            'kind',
            'content',
            'content_message',
            'language',
            'task_id',
            'created_at',
          ])
          .where('conversation_id', '=', conversationId)
          .where('task_id', 'in', taskIds)
          .where('role', 'in', ['user', 'assistant'])
          .orderBy('created_at')
          .orderBy('id')
          .execute()
      : Promise.resolve([]),
  ]);

  const userMessage = new Map<string, (typeof messages)[number]>();
  const assistantMessage = new Map<string, (typeof messages)[number]>();
  for (const m of messages) {
    if (!m.task_id) continue;
    const target = m.role === 'assistant' ? assistantMessage : userMessage;
    // The first request message per task (a task has one).
    if (!target.has(m.task_id)) target.set(m.task_id, m);
  }

  const turns: ConversationTurn[] = [];
  for (const id of [...taskIds].reverse()) {
    const task = summaries.get(id);
    if (!task) continue;
    const um = userMessage.get(id);
    if (um) turns.push({ type: 'user_message', message: toMessage(um, attachments.get(id) ?? []) });
    turns.push({ type: 'task', task });
    const am = assistantMessage.get(id);
    if (am) turns.push({ type: 'assistant_message', message: toMessage(am, []) });
  }

  return {
    ...toSummary(conv, conv.last_task_id ? (summaries.get(conv.last_task_id) ?? null) : null),
    turns,
    earlierCursor:
      hasEarlier && oldestOnPage
        ? encodeCursor({ t: oldestOnPage.cursor_ts, i: oldestOnPage.id })
        : null,
    canFollowUp: conv.active_task_id === null,
    activeTaskId: conv.active_task_id,
  };
}
