/**
 * conversation.recall — hand an earlier result of the same conversation to a
 * later step ("email it to me", "remember that"). docs/architecture/phase-b.md §3.1.
 *
 * The task id must come from the deterministic planning context (validatePlan:
 * a recallable earlier task of this conversation, never a reference). The tool
 * re-reads the task through RLS, checks it is in this conversation and
 * COMPLETED with a text result, and returns it with the injection flag of
 * the steps that produced it — so the existing taint propagation
 * (isTainted → UNTRUSTED_CONTENT approval, UNTRUSTED_MEMORY deny) applies to
 * everything built from it. The result is data; it never adds steps or
 * chooses recipients (recipients are fixed and literal at planning time).
 */
import { z } from 'zod';
import { withContext } from '../../../db/pool';
import { truncate } from '../../../lib/redact';
import { recallableResult, stepsFlagged } from '../conversation-context';
import { AgentError } from '../errors';
import { hasTemplate } from '../templates';
import { splitSentences } from './text-summarize';
import { check, evidence, genericApprovalSummary, type ToolDefinition } from './types';

export const RecallInput = z.object({
  taskId: z
    .string()
    .uuid()
    .describe(
      'The id of an earlier task of this conversation whose result to reuse, exactly as given in <conversation>. Never a reference.',
    ),
});
export type RecallInput = z.infer<typeof RecallInput>;

export const RECALL_MAX_TEXT = 20_000;
export const RECALL_MAX_EXCERPT = 1_000;

/**
 * At most `max` characters of `text`, cut at a sentence end when there is one
 * (for memory.save, whose content is at most 1 000 characters).
 */
export function excerptOf(text: string, max = RECALL_MAX_EXCERPT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  let out = '';
  for (const s of splitSentences(text)) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > max) break;
    out = next;
  }
  return out || truncate(flat, max);
}

const nothingToRecall = () =>
  new AgentError(
    'TOOL_FAILED',
    'There is no earlier result in this conversation that JARVIS could use.',
    { retryable: false, reason: 'NOTHING_TO_RECALL' },
  );

export const conversationRecallTool: ToolDefinition<RecallInput> = {
  id: 'conversation.recall',
  version: '1.0.0',
  description:
    'Get the result (answer, summary, document analysis or translation) of an earlier task in this conversation, so a later step can use it, e.g. email it or remember it. Read-only. Output: text (full result), excerpt (at most 1000 characters, for memory.save), title, sourceUrl.',
  inputSchema: RecallInput,
  validatePlanned(input) {
    return typeof input.taskId === 'string' && hasTemplate(input.taskId)
      ? ['conversation.recall "taskId" must be a literal task id from <conversation>.']
      : [];
  },
  contextIds: (input) => [{ kind: 'task', id: input.taskId }],
  outputFields: ['text', 'excerpt', 'title', 'sourceUrl', 'suspectedInjection'],
  requiredConnection: null,
  permissions: [],
  sideEffect: 'none',
  idempotency: 'safe_to_retry',
  timeoutMs: 10_000,
  retry: { maxAttempts: 2, retryableCodes: ['INTERNAL'] },
  modelUse: 'none',
  riskLevel: () => 'LOW',
  estimateCostMicro: () => 0,
  preview: (input) => ({ taskId: input.taskId }),
  approvalDetails: (input, ctx) => ({
    details: {
      kind: 'generic',
      toolId: 'conversation.recall',
      fields: [{ label: 'Task', value: input.taskId }],
    },
    ...genericApprovalSummary(ctx, 'conversation.recall'),
  }),
  async execute(input, rt) {
    const found = await withContext(rt.db, rt.ctx, async (trx) => {
      const task = await trx
        .selectFrom('tasks')
        .select(['id', 'title', 'status', 'conversation_id'])
        .where('id', '=', input.taskId)
        .executeTakeFirst();
      if (!task || task.conversation_id !== rt.conversationId || task.id === rt.taskId) return null;
      if (task.status !== 'COMPLETED') return null;
      const steps = await trx
        .selectFrom('task_steps')
        .select(['tool_id', 'status', 'output', 'title', 'position'])
        .where('task_id', '=', task.id)
        .execute();
      return { task, steps };
    });
    if (!found) throw nothingToRecall();
    const result = recallableResult(found.steps);
    if (!result) throw nothingToRecall();
    const flags = stepsFlagged(found.steps);
    let sourceUrl: string | null = null;
    for (const s of [...found.steps].sort((a, b) => a.position - b.position)) {
      const url = (s.output as Record<string, unknown> | null)?.finalUrl;
      if (s.tool_id === 'web.fetch' && s.status === 'SUCCEEDED' && typeof url === 'string') {
        sourceUrl = url;
        break;
      }
    }
    const text = truncate(result.text, RECALL_MAX_TEXT);
    const output = {
      taskId: found.task.id,
      text,
      excerpt: excerptOf(result.text),
      title: found.task.title,
      sourceUrl,
      sourceTool: result.toolId,
      suspectedInjection: flags.flagged,
      injectionSignals: flags.signals,
    };
    return {
      output,
      outputPreview: {
        taskId: found.task.id,
        title: found.task.title,
        excerpt: truncate(text, 280),
        textChars: text.length,
        suspectedInjection: flags.flagged,
      },
      evidence: [
        evidence('record', 'Earlier result', `task ${found.task.id}`, 'RECALLED_RESULT', {
          taskId: found.task.id,
        }),
      ],
      costMicro: 0,
    };
  },
  verify(input, output) {
    const text = typeof output.text === 'string' ? output.text : '';
    return {
      ok: text.trim().length > 0 && output.taskId === input.taskId,
      checks: [check('resultRecalled', `Result of task ${input.taskId}`, { taskId: input.taskId })],
    };
  },
};
