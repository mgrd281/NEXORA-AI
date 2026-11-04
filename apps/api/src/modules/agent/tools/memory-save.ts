/**
 * memory.save — store a note in the user's long-term memory.
 * Content is literal text from the user's request — or (Phase B, "remember
 * that") exactly one reference to a conversation.recall output, the earlier
 * result the user points at. Memories are later shown to the planner as the
 * user's own notes, so content must never be able to plant one: a
 * referenced text needs the user's approval of the exact text
 * (MEMORY_FROM_CONTENT) and is denied when it derives from flagged content
 * (UNTRUSTED_MEMORY) — see policy.ts. Idempotent per task (same content saved
 * by the same task is reused), hence safe to retry.
 */
import { MemoryKind } from '@jarvis/contracts';
import { z } from 'zod';
import { withContext } from '../../../db/pool';
import { truncate } from '../../../lib/redact';
import { AgentError } from '../errors';
import { msg, render, withoutFinalStop } from '../i18n';
import { findRefs, hasTemplate } from '../templates';
import { check, evidence, type ToolDefinition } from './types';

export const MemorySaveInput = z.object({
  content: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe(
      'The note to remember, in the user\'s own words from the request. The only allowed reference is {{sN.excerpt}} of a conversation.recall step ("remember that").',
    ),
  kind: MemoryKind.describe('"preference" for likes/dislikes and habits, otherwise "fact".'),
});
export type MemorySaveInput = z.infer<typeof MemorySaveInput>;

/**
 * A note as it sits inside a quoted sentence ("Saved to memory: “…”."): one
 * line, at most 120 characters, without its own final full stop (the
 * sentence around it ends with one).
 */
export function quotable(content: string): string {
  return withoutFinalStop(truncate(content.replace(/\s+/g, ' ').trim(), 120));
}

export const memorySaveTool: ToolDefinition<MemorySaveInput> = {
  id: 'memory.save',
  version: '1.0.0',
  description:
    "Save a short note (a preference or a fact the user stated) to the user's long-term memory so JARVIS can use it later. Only for things the user explicitly asked to remember.",
  inputSchema: MemorySaveInput,
  validatePlanned(input) {
    if (typeof input.content !== 'string' || !hasTemplate(input.content)) return [];
    // Exactly one whole-field reference (to a conversation.recall output: allowedRefTools).
    const refs = findRefs(input.content);
    return refs.length === 1 && /^\{\{\s*s\d\.excerpt\s*\}\}$/.test(input.content.trim())
      ? []
      : [
          'memory.save "content" must be literal text from the request, or exactly {{sN.excerpt}} of a conversation.recall step.',
        ];
  },
  allowedRefTools: ['conversation.recall'],
  outputFields: ['memoryId', 'content', 'kind'],
  requiredConnection: null,
  permissions: ['memory:write'],
  sideEffect: 'internal',
  idempotency: 'safe_to_retry',
  timeoutMs: 10_000,
  retry: { maxAttempts: 2, retryableCodes: ['INTERNAL'] },
  modelUse: 'none',
  riskLevel: () => 'LOW',
  estimateCostMicro: () => 0,
  preview: (input) => ({ content: input.content, kind: input.kind }),
  approvalDetails: (input, ctx) => {
    if (ctx.fromContent) {
      // MEMORY_FROM_CONTENT: exactly the text that would be kept.
      const summaryMessage = msg('approval.memory', { text: quotable(input.content) });
      return {
        details: {
          kind: 'memory',
          content: input.content,
          memoryKind: input.kind,
          sourceTaskId: ctx.recalledTaskId ?? null,
        },
        summary: render(ctx.language, summaryMessage),
        summaryMessage,
      };
    }
    const summaryMessage = msg('result.memorySaved', { text: quotable(input.content) });
    return {
      details: {
        kind: 'generic',
        toolId: 'memory.save',
        fields: [
          { label: 'Note', value: input.content },
          { label: 'Kind', value: input.kind },
        ],
      },
      summary: render(ctx.language, summaryMessage),
      summaryMessage,
    };
  },
  async execute(input, rt) {
    if (!rt.preferences.memory.enabled) {
      throw new AgentError('POLICY_DENIED', 'Memory is turned off in your privacy settings.', {
        reason: 'MEMORY_DISABLED',
      });
    }
    const row = await withContext(rt.db, rt.ctx, async (trx) => {
      const existing = await trx
        .selectFrom('memories')
        .select(['id', 'created_at'])
        .where('source_task_id', '=', rt.taskId)
        .where('content', '=', input.content)
        .executeTakeFirst();
      if (existing) return { ...existing, created: false };
      const inserted = await trx
        .insertInto('memories')
        .values({
          tenant_id: rt.ctx.tenantId,
          user_id: rt.ctx.userId,
          kind: input.kind,
          content: input.content,
          source: 'assistant',
          source_task_id: rt.taskId,
        })
        .returning(['id', 'created_at'])
        .executeTakeFirstOrThrow();
      return { ...inserted, created: true };
    });
    const output = {
      memoryId: row.id,
      content: input.content,
      kind: input.kind,
      created: row.created,
    };
    return {
      output,
      outputPreview: { memoryId: row.id, content: input.content, kind: input.kind },
      evidence: [
        evidence('record', 'Memory saved', `memory ${row.id} (${input.kind})`, 'MEMORY_RECORD', {
          memoryId: row.id,
          kind: input.kind,
        }),
      ],
      costMicro: 0,
    };
  },
  verify(input, output) {
    const ok = typeof output.memoryId === 'string' && output.content === input.content;
    return {
      ok,
      checks: [
        ok
          ? check('memoryStored', `Memory ${String(output.memoryId)} stored`, {
              id: String(output.memoryId),
            })
          : check('memoryMissing', 'Memory record missing'),
      ],
    };
  },
  audit: (input) => ({
    action: 'memory.saved',
    metadata: { kind: input.kind, source: 'assistant' },
  }),
};
