/**
 * Pure helpers for conversation threads: turns grouped per task (request → task → JARVIS's
 * message), split around the task a page is about, and the copy of a clarifying question.
 * No React, no I/O — unit-tested in test/conversations.test.ts.
 */
import type {
  AssistantQuestion,
  ConversationMessage,
  ConversationTurn,
  TaskSummary,
} from '@jarvis/contracts';
import { isTerminal } from '@jarvis/contracts';
import { renderServerMessage, type ServerTextI18n } from '@/i18n/server-message';

export interface TurnGroup {
  taskId: string;
  request: ConversationMessage | null;
  task: TaskSummary | null;
  reply: ConversationMessage | null;
}

/** Turns as one group per task, in thread order. Messages without a task stand alone. */
export function groupTurns(turns: readonly ConversationTurn[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  const byTask = new Map<string, TurnGroup>();
  const groupFor = (taskId: string | null, fallbackKey: string): TurnGroup => {
    const key = taskId ?? fallbackKey;
    let group = byTask.get(key);
    if (!group) {
      group = { taskId: key, request: null, task: null, reply: null };
      byTask.set(key, group);
      groups.push(group);
    }
    return group;
  };
  for (const turn of turns) {
    switch (turn.type) {
      case 'user_message':
        groupFor(turn.message.taskId, turn.message.id).request = turn.message;
        break;
      case 'task':
        groupFor(turn.task.id, turn.task.id).task = turn.task;
        break;
      case 'assistant_message':
        groupFor(turn.message.taskId, turn.message.id).reply = turn.message;
        break;
    }
  }
  return groups;
}

/** The groups before and after the task a page shows (`current` is null when not loaded). */
export function splitAround(
  groups: readonly TurnGroup[],
  taskId: string,
): { earlier: TurnGroup[]; current: TurnGroup | null; later: TurnGroup[] } {
  const index = groups.findIndex((g) => g.taskId === taskId);
  if (index < 0) return { earlier: [], current: null, later: [...groups] };
  return {
    earlier: groups.slice(0, index),
    current: groups[index]!,
    later: groups.slice(index + 1),
  };
}

/** A completed task that ended by asking the user something. */
export function isQuestion(task: Pick<TaskSummary, 'status' | 'outcome'>): boolean {
  return task.status === 'COMPLETED' && task.outcome === 'question';
}

/** A task that is still in progress (blocks follow-ups in its conversation). */
export function isActive(task: Pick<TaskSummary, 'status'>): boolean {
  return !isTerminal(task.status);
}

/** The question in the viewer's language: the server's sentence, else the stored text. */
export function questionText(
  i18n: ServerTextI18n,
  question: Pick<AssistantQuestion, 'text' | 'message'> | null | undefined,
  fallback: string | null = null,
): string | null {
  if (!question) return fallback;
  return renderServerMessage(i18n, question.message) ?? question.text;
}

/** What JARVIS said, in the viewer's language when the server composed it. */
export function messageText(
  i18n: ServerTextI18n,
  message: Pick<ConversationMessage, 'text' | 'textMessage'>,
): { text: string; localized: boolean } {
  const rendered = renderServerMessage(i18n, message.textMessage);
  return rendered !== null ? { text: rendered, localized: true } : { text: message.text, localized: false };
}
