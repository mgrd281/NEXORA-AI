/**
 * Conversation context for follow-ups (docs/architecture/phase-b.md §3.1):
 * the earlier turns of a task's conversation, as the planner and
 * validatePlan see them. Requests are the user's own words (still escaped as
 * data); results are untrusted data — they may quote web pages or documents —
 * and carry the injection flag of the steps that produced them.
 *
 * Bounded by CONVERSATION_LIMITS: at most `contextTasks` earlier tasks
 * (newest kept), `contextCharsPerTurn` characters per result and
 * `contextCharsTotal` characters of results overall.
 */
import {
  CONVERSATION_LIMITS,
  MissingInfo,
  type TaskOutcome,
  type TaskStatus,
  type ToolId,
} from '@jarvis/contracts';
import type { Trx } from '../../db/pool';
import type { StepRow } from '../../db/types';
import { truncate } from '../../lib/redact';

export interface PriorTurn {
  taskId: string;
  /** The user's own words (trusted as theirs, still escaped). */
  request: string;
  status: TaskStatus;
  outcome: TaskOutcome | null;
  title: string;
  /** Answer / summary / translation / question / result line, ≤ contextCharsPerTurn. */
  resultText: string | null;
  /** Some step feeding the result was flagged as suspected prompt injection. */
  flagged: boolean;
  /** A result conversation.recall can return (answer, summary, analysis, translation). */
  recallable: boolean;
  /** When the turn asked a clarifying question: what it asked for. */
  missing?: MissingInfo[];
}

/** Tools whose output is a text result conversation.recall can hand on, and its field. */
export const RECALLABLE_FIELD: Partial<Record<ToolId, string>> = {
  'assistant.answer': 'answer',
  'text.summarize': 'summary',
  'document.analyze': 'result',
  'text.translate': 'translation',
};

type Out = Record<string, unknown> | null;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * The text result of a completed task's steps: the last succeeded step that
 * produces one (a translation of a summary is the translation), or null.
 */
export function recallableResult(
  steps: Pick<StepRow, 'tool_id' | 'status' | 'output' | 'title' | 'position'>[],
): { text: string; toolId: ToolId; stepTitle: string } | null {
  const ordered = [...steps].sort((a, b) => b.position - a.position);
  for (const s of ordered) {
    if (s.status !== 'SUCCEEDED') continue;
    const field = RECALLABLE_FIELD[s.tool_id as ToolId];
    if (!field) continue;
    const text = str((s.output as Out)?.[field]).trim();
    if (text) return { text, toolId: s.tool_id as ToolId, stepTitle: s.title };
  }
  return null;
}

/** Whether any of the steps produced output flagged as a suspected prompt injection. */
export function stepsFlagged(steps: Pick<StepRow, 'output'>[]): {
  flagged: boolean;
  signals: string[];
} {
  const signals = new Set<string>();
  let flagged = false;
  for (const s of steps) {
    const out = s.output as Out;
    if (out?.suspectedInjection !== true) continue;
    flagged = true;
    const list = out.injectionSignals;
    if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') signals.add(id);
  }
  return { flagged, signals: [...signals].sort() };
}

/**
 * Earlier turns of `conversationId`, created before `beforeTaskId`,
 * chronological (oldest first). Runs inside the caller's RLS context.
 */
export async function loadConversationContext(
  trx: Trx,
  conversationId: string,
  beforeTaskId: string,
): Promise<PriorTurn[]> {
  const current = await trx
    .selectFrom('tasks')
    .select(['created_at', 'id'])
    .where('id', '=', beforeTaskId)
    .executeTakeFirst();
  let q = trx
    .selectFrom('tasks')
    .select([
      'id',
      'request',
      'status',
      'outcome',
      'title',
      'answer',
      'question',
      'result_summary',
      'created_at',
    ])
    .where('conversation_id', '=', conversationId)
    .where('id', '<>', beforeTaskId);
  if (current) {
    q = q.where((eb) =>
      eb.or([
        eb('created_at', '<', current.created_at),
        eb.and([eb('created_at', '=', current.created_at), eb('id', '<', current.id)]),
      ]),
    );
  }
  const tasks = await q
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(CONVERSATION_LIMITS.contextTasks)
    .execute();
  if (tasks.length === 0) return [];
  const steps = await trx
    .selectFrom('task_steps')
    .select(['task_id', 'tool_id', 'status', 'output', 'title', 'position'])
    .where(
      'task_id',
      'in',
      tasks.map((t) => t.id),
    )
    .execute();
  const byTask = new Map<string, typeof steps>();
  for (const s of steps) {
    const list = byTask.get(s.task_id) ?? [];
    list.push(s);
    byTask.set(s.task_id, list);
  }

  let budget: number = CONVERSATION_LIMITS.contextCharsTotal;
  const turns: PriorTurn[] = [];
  // Newest first, so the most recent results keep their text when the budget runs out.
  for (const t of tasks) {
    const taskSteps = byTask.get(t.id) ?? [];
    const result = t.status === 'COMPLETED' ? recallableResult(taskSteps) : null;
    let text: string | null = null;
    if (t.status === 'COMPLETED') {
      if (t.outcome === 'question' && t.question && typeof t.question === 'object')
        text = str((t.question as { text?: unknown }).text) || null;
      else text = result?.text ?? t.answer ?? t.result_summary ?? null;
    }
    if (text !== null) {
      const room = Math.min(CONVERSATION_LIMITS.contextCharsPerTurn, budget);
      text = room > 0 ? truncate(text, Math.max(1, room)) : null;
      budget -= text?.length ?? 0;
    }
    const asked =
      t.outcome === 'question' && t.question && typeof t.question === 'object'
        ? MissingInfo.array().safeParse((t.question as { missing?: unknown }).missing)
        : null;
    turns.push({
      ...(asked?.success ? { missing: asked.data } : {}),
      taskId: t.id,
      request: t.request,
      status: t.status,
      outcome: t.outcome,
      title: t.title,
      resultText: text,
      flagged: stepsFlagged(taskSteps).flagged,
      recallable: result !== null,
    });
  }
  return turns.reverse();
}

/** The newest earlier turn whose result conversation.recall can use. */
export function latestRecallable(turns: readonly PriorTurn[]): PriorTurn | null {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.recallable) return turns[i]!;
  return null;
}
