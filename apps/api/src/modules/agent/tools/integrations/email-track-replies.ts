/**
 * email.track_replies — watch a conversation for a reply (polling job
 * email.watch_poll; notification email_reply_received when someone other
 * than the account answers). LOW, internal side effect (a watch row; nothing
 * leaves JARVIS), exactly once per step (unique step_id). Only the subject and
 * the sender of a reply are kept, never content.
 */
import { EMAIL_LIMITS } from '@jarvis/contracts';
import { z } from 'zod';
import { mailClient } from '../../../integrations/mail';
import { threadNotFound } from '../../../integrations/mail-errors';
import { createWatch } from '../../../integrations/watches';
import { msg } from '../../i18n';
import { check, evidence, genericApprovalSummary, type ToolDefinition } from '../types';
import { ProviderField, bindProvider, connectionFor, optionsFor, requiresFor } from './common';

export const EmailTrackRepliesInput = z.object({
  provider: ProviderField,
  threadId: z
    .string()
    .min(1)
    .max(512)
    .describe(
      'The conversation to watch, e.g. {{s1.threadId}} of email.send or {{s1.firstThreadId}}.',
    ),
  days: z
    .number()
    .int()
    .min(1)
    .max(EMAIL_LIMITS.watchMaxDays)
    .default(EMAIL_LIMITS.watchDefaultDays),
});
export type EmailTrackRepliesInput = z.infer<typeof EmailTrackRepliesInput>;

export const emailTrackRepliesTool: ToolDefinition<EmailTrackRepliesInput> = {
  id: 'email.track_replies',
  version: '1.0.0',
  description:
    'Watch an email conversation and notify the user when someone replies (for up to 30 days). Output: watchId, expiresAt.',
  inputSchema: EmailTrackRepliesInput,
  allowedRefTools: ['email.send', 'email.search', 'email.read_thread', 'email.draft_reply'],
  outputFields: ['watchId', 'expiresAt', 'subject'],
  requiredConnection: null,
  connectionOptions: optionsFor('mail.read'),
  requires: requiresFor('mail.read'),
  bind: (input, ctx) =>
    input.provider ? input : { ...input, provider: bindProvider('mail.read', ctx) },
  permissions: ['email:read'],
  sideEffect: 'internal',
  idempotency: 'once_per_step',
  timeoutMs: 30_000,
  retry: { maxAttempts: 1, retryableCodes: [] },
  modelUse: 'none',
  riskLevel: () => 'LOW',
  estimateCostMicro: () => 0,
  preview: (input) => ({ ...input }),
  approvalDetails: (input, ctx) => ({
    details: {
      kind: 'generic',
      toolId: 'email.track_replies',
      fields: [
        { label: 'Thread', value: input.threadId },
        { label: 'Days', value: String(input.days) },
      ],
    },
    ...genericApprovalSummary(ctx, 'email.track_replies'),
  }),
  async execute(input, rt, signal) {
    const conn = await connectionFor(rt, input.provider, 'mail.read');
    const thread = await mailClient(rt, rt.ctx, conn).threadMeta(input.threadId, signal);
    if (!thread) throw threadNotFound();
    const newest = thread.messages.at(-1)!;
    const { row, created } = await createWatch(rt, rt.ctx, {
      connectionId: conn.id,
      provider: conn.provider,
      threadId: thread.id,
      subject: thread.subject,
      taskId: rt.taskId,
      stepId: rt.stepId,
      days: input.days,
      baseline: { messageId: newest.id, at: newest.date },
    });
    const expiresAt = new Date(row.expires_at).toISOString();
    return {
      output: {
        provider: conn.provider,
        watchId: row.id,
        expiresAt,
        threadId: row.thread_id,
        subject: row.subject,
        reused: !created,
      },
      outputPreview: { watchId: row.id, expiresAt, subject: row.subject },
      evidence: [
        evidence('record', 'Reply watch', `${row.id} until ${expiresAt}`, 'EMAIL_WATCH', {
          watchId: row.id,
          expiresAt,
        }),
      ],
      costMicro: 0,
    };
  },
  verify: (_input, output) => ({
    ok: typeof output.watchId === 'string' && output.watchId.length > 0,
    checks: [
      check('watchCreated', `Watching for replies (${String(output.watchId)})`, {
        id: String(output.watchId ?? ''),
      }),
    ],
  }),
  resultLine: (_input, output) =>
    msg('result.watchingReplies', { subject: String(output.subject ?? '') }),
  resultFact: (_input, output) =>
    `Watching the conversation for replies until ${String(output.expiresAt)}.`,
  audit: (_input, output) => ({
    action: 'email.watch_created',
    metadata: { provider: output.provider, watchId: output.watchId },
  }),
};
