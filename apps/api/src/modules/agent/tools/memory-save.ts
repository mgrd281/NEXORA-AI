/**
 * memory.save — store a note in the user's long-term memory.
 * Content must be literal text from the user's request (no {{refs}}): memories
 * are later shown to the planner as the user's own notes, so fetched content
 * must never be able to plant one. Idempotent per task (same content saved by
 * the same task is reused), hence safe to retry.
 */
import { MemoryKind } from '@jarvis/contracts';
import { z } from 'zod';
import { withContext } from '../../../db/pool';
import { truncate } from '../../../lib/redact';
import { AgentError } from '../errors';
import { t } from '../i18n';
import { hasTemplate } from '../templates';
import { evidence, type ToolDefinition } from './types';

export const MemorySaveInput = z.object({
  content: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe("The note to remember, in the user's own words from the request. No references."),
  kind: MemoryKind.describe('"preference" for likes/dislikes and habits, otherwise "fact".'),
});
export type MemorySaveInput = z.infer<typeof MemorySaveInput>;

export const memorySaveTool: ToolDefinition<MemorySaveInput> = {
  id: 'memory.save',
  version: '1.0.0',
  description:
    "Save a short note (a preference or a fact the user stated) to the user's long-term memory so JARVIS can use it later. Only for things the user explicitly asked to remember.",
  inputSchema: MemorySaveInput,
  validatePlanned(input) {
    return typeof input.content === 'string' && hasTemplate(input.content)
      ? ['memory.save "content" must be literal text from the request; references are not allowed.']
      : [];
  },
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
  approvalDetails: (input, ctx) => ({
    details: {
      kind: 'generic',
      toolId: 'memory.save',
      fields: [
        { label: 'Note', value: input.content },
        { label: 'Kind', value: input.kind },
      ],
    },
    summary: t(ctx.language, 'result.memorySaved', { text: truncate(input.content, 120) }),
  }),
  async execute(input, rt) {
    if (!rt.preferences.memory.enabled) {
      throw new AgentError('POLICY_DENIED', 'Memory is turned off in your privacy settings.');
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
      evidence: [evidence('record', 'Memory saved', `memory ${row.id} (${input.kind})`)],
      costMicro: 0,
    };
  },
  verify(input, output) {
    const ok = typeof output.memoryId === 'string' && output.content === input.content;
    return {
      ok,
      checks: [ok ? `Memory ${String(output.memoryId)} stored` : 'Memory record missing'],
    };
  },
  audit: (input) => ({
    action: 'memory.saved',
    metadata: { kind: input.kind, source: 'assistant' },
  }),
};
