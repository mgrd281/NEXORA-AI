import type { ConversationMessage, ConversationTurn, TaskSummary } from '@jarvis/contracts';
import { describe, expect, it } from 'vitest';
import {
  answeredQuestions,
  groupTurns,
  isActive,
  isQuestion,
  messageText,
  questionText,
  splitAround,
} from '@/features/conversations/model';
import { LOCALES } from '@/i18n/config';
import { catalogs } from '@/i18n/messages';
import { createTranslator, stripIsolates } from '@/i18n/translate';

const i18n = (locale: (typeof LOCALES)[number]) => ({
  t: createTranslator(locale, catalogs[locale]),
  messages: catalogs[locale],
});

const T = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = (n: number) => new Date(Date.UTC(2026, 10, 4, 9, n)).toISOString();

function task(n: number, extra: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: T(n),
    title: `Task ${n}`,
    titleMessage: null,
    request: `Request ${n}`,
    status: 'COMPLETED',
    riskLevel: 'LOW',
    source: 'text',
    progress: { completed: 1, total: 1 },
    pendingApprovalId: null,
    pendingApproval: null,
    resultSummary: null,
    resultSummaryMessage: null,
    error: null,
    createdAt: AT(n),
    updatedAt: AT(n),
    completedAt: AT(n),
    conversationId: T(900),
    outcome: 'answer',
    question: null,
    scheduleId: null,
    attachmentCount: 0,
    ...extra,
  };
}

function message(
  n: number,
  taskId: string | null,
  role: 'user' | 'assistant',
): ConversationMessage {
  return {
    id: T(500 + n),
    role,
    kind: role === 'user' ? 'request' : 'answer',
    text: `${role} ${n}`,
    textMessage: null,
    language: 'en',
    taskId,
    attachments: [],
    createdAt: AT(n),
  };
}

describe('groupTurns', () => {
  it('groups request, task and reply per task, in thread order', () => {
    const turns: ConversationTurn[] = [
      { type: 'user_message', message: message(1, T(1), 'user') },
      { type: 'task', task: task(1) },
      { type: 'assistant_message', message: message(2, T(1), 'assistant') },
      { type: 'user_message', message: message(3, T(2), 'user') },
      { type: 'task', task: task(2, { status: 'RUNNING', outcome: null }) },
    ];
    const groups = groupTurns(turns);
    expect(groups.map((g) => g.taskId)).toEqual([T(1), T(2)]);
    expect(groups[0]).toMatchObject({
      request: { text: 'user 1' },
      reply: { text: 'assistant 2' },
    });
    expect(groups[1]!.reply).toBeNull();
    expect(groups[1]!.task?.status).toBe('RUNNING');
  });

  it('keeps a message without a task as its own group', () => {
    const groups = groupTurns([{ type: 'user_message', message: message(1, null, 'user') }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ taskId: T(501), task: null });
  });
});

describe('splitAround', () => {
  const groups = groupTurns([1, 2, 3].map((n) => ({ type: 'task', task: task(n) }) as const));

  it('splits earlier and later turns around the page’s task', () => {
    const { earlier, current, later } = splitAround(groups, T(2));
    expect(earlier.map((g) => g.taskId)).toEqual([T(1)]);
    expect(current?.taskId).toBe(T(2));
    expect(later.map((g) => g.taskId)).toEqual([T(3)]);
  });

  it('treats every loaded turn as later when the task is not on the loaded pages', () => {
    const { earlier, current, later } = splitAround(groups, T(9));
    expect(earlier).toEqual([]);
    expect(current).toBeNull();
    expect(later).toHaveLength(3);
  });
});

describe('questions', () => {
  it('a question is a completed task with outcome question; it never blocks follow-ups', () => {
    expect(isQuestion(task(1, { outcome: 'question' }))).toBe(true);
    expect(isQuestion(task(1, { outcome: 'answer' }))).toBe(false);
    expect(isQuestion(task(1, { status: 'FAILED', outcome: null }))).toBe(false);
    expect(isActive(task(1, { outcome: 'question' }))).toBe(false);
    expect(isActive(task(1, { status: 'AWAITING_APPROVAL', outcome: null }))).toBe(true);
  });

  it('renders the server’s question in the viewer’s language, else the stored text', () => {
    const asked = {
      text: 'Who should receive it? Write their email address.',
      message: { key: 'question.recipient' as const, params: {} },
    };
    for (const locale of LOCALES) {
      const text = questionText(i18n(locale), asked);
      expect(text).toBeTruthy();
      if (locale !== 'en') expect(text).not.toBe(asked.text);
    }
    expect(questionText(i18n('de'), { text: 'Welche Datei?', message: null })).toBe(
      'Welche Datei?',
    );
    expect(questionText(i18n('en'), null, 'fallback')).toBe('fallback');
  });

  it('marks what JARVIS said as localized only when the server composed it', () => {
    const plain = messageText(i18n('ar'), { text: 'Model answer', textMessage: null });
    expect(plain).toEqual({ text: 'Model answer', localized: false });
    const composed = messageText(i18n('de'), {
      text: 'Saved.',
      textMessage: { key: 'question.document', params: {} },
    });
    expect(composed.localized).toBe(true);
    expect(stripIsolates(composed.text)).not.toBe('Saved.');
  });
});

describe('answeredQuestions', () => {
  it('finds questions that a newer request of the same conversation answered', () => {
    const other = T(901);
    const tasks = [
      task(5, { conversationId: other, outcome: 'question' }), // newest of its conversation
      task(4, { status: 'RUNNING', outcome: null }), // the answer to task 2
      task(2, { outcome: 'question' }),
      task(1, { outcome: 'question', conversationId: undefined }),
    ];
    expect([...answeredQuestions(tasks)]).toEqual([T(2)]);
  });

  it('is empty when nothing follows a question', () => {
    expect(answeredQuestions([task(1, { outcome: 'question' })]).size).toBe(0);
  });
});
