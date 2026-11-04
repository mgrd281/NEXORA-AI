/**
 * What a completed task produced (docs/architecture/phase-b.md §3.1–3.2):
 *
 *   outcome   question — a step asked the user (assistant.clarify)
 *             answer   — only steps without side effects (text for the user)
 *             action   — something was done (email sent, memory saved, schedule created)
 *   message   JARVIS's turn in the conversation, inserted exactly once per task
 *             (unique partial index; ON CONFLICT DO NOTHING): the answer text,
 *             the question, or the result line.
 * Failed, cancelled and expired tasks get no JARVIS message (the task turn
 * shows the error).
 */
import type {
  AssistantQuestion,
  MissingInfo,
  ServerMessage,
  TaskOutcome,
  ToolId,
} from '@jarvis/contracts';
import { sql } from 'kysely';
import type { DbContext, Trx } from '../../db/pool';
import type { MessageKindValue, StepRow, TaskRow } from '../../db/types';
import { appendEvent } from '../events/events';
import { recallableResult } from './conversation-context';
import { asMessage } from './i18n';
import { getTool } from './tools/registry';

type Out = Record<string, unknown> | null;

/** The clarifying question of a task's steps, if one asked. */
export function questionOf(steps: StepRow[]): AssistantQuestion | null {
  const step = steps.find((s) => s.tool_id === 'assistant.clarify' && s.status === 'SUCCEEDED');
  if (!step) return null;
  const out = step.output as Out;
  const text = typeof out?.question === 'string' ? out.question : '';
  const missing = Array.isArray(out?.missing) ? (out.missing as MissingInfo[]) : [];
  if (!text || missing.length === 0) return null;
  return { text, message: asMessage(out?.questionMessage), missing };
}

export function taskOutcome(steps: StepRow[]): TaskOutcome {
  if (questionOf(steps)) return 'question';
  const done = steps.filter((s) => s.status === 'SUCCEEDED');
  const quiet = done.every((s) => getTool(s.tool_id as ToolId)?.sideEffect === 'none');
  return quiet && done.length > 0 ? 'answer' : 'action';
}

/**
 * JARVIS's message for a completed task, once. `summary` / `summaryMessage`
 * are the task's result line (used for action outcomes). Returns the message
 * id, or null when the task already has one.
 */
export async function insertAssistantMessage(
  trx: Trx,
  ctx: DbContext,
  task: TaskRow,
  steps: StepRow[],
  r: {
    outcome: TaskOutcome;
    question: AssistantQuestion | null;
    summary: string;
    summaryMessage: ServerMessage | null;
  },
): Promise<string | null> {
  let kind: MessageKindValue;
  let content: string;
  let contentMessage: ServerMessage | null = null;
  if (r.outcome === 'question' && r.question) {
    kind = 'question';
    content = r.question.text;
    contentMessage = r.question.message;
  } else if (r.outcome === 'answer') {
    kind = 'answer';
    const result = recallableResult(steps);
    content = result?.text ?? task.answer ?? r.summary;
    contentMessage = result || task.answer ? null : r.summaryMessage;
  } else {
    kind = 'result';
    content = r.summary;
    contentMessage = r.summaryMessage;
  }
  if (!content.trim()) return null;
  const inserted = await trx
    .insertInto('messages')
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      conversation_id: task.conversation_id,
      task_id: task.id,
      role: 'assistant',
      kind,
      content,
      content_message: contentMessage ? JSON.stringify(contentMessage) : null,
      language: task.language,
    })
    // The arbiter of a partial unique index needs its predicate as literal SQL.
    .onConflict((oc) =>
      oc
        .column('task_id')
        .where(sql<boolean>`role = 'assistant' AND task_id IS NOT NULL`)
        .doNothing(),
    )
    .returning('id')
    .executeTakeFirst();
  if (!inserted) return null;
  await trx
    .updateTable('conversations')
    .set({ updated_at: new Date() })
    .where('id', '=', task.conversation_id)
    .execute();
  await appendEvent(trx, ctx, {
    taskId: task.id,
    type: 'conversation.message',
    data: {
      conversationId: task.conversation_id,
      messageId: inserted.id,
      taskId: task.id,
      role: 'assistant',
      kind,
    },
  });
  return inserted.id;
}
