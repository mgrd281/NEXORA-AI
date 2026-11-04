/**
 * email.draft_reply — save a reply as a DRAFT in the user's mailbox (Gmail
 * drafts.create in the thread / Graph createReply + PATCH). Nothing is sent.
 *
 * MEDIUM, approval first (docs/architecture/phase-c.md §3.2, decided): a
 * draft writes into an external system (the mailbox) but is reversible and
 * reaches nobody — the permission model's MEDIUM. It still asks, showing the
 * exact recipients, subject and body, because a reply's recipients come from
 * the thread's headers (written by others: Reply-To can point anywhere) and
 * its body may be model-written from untrusted mail. At execution the draft
 * gets exactly the approved recipients, and each must already be a
 * participant of the thread (content can never add a new address).
 */
import { EMAIL_LIMITS } from '@jarvis/contracts';
import { z } from 'zod';
import { truncate } from '../../../../lib/redact';
import { mailClient } from '../../../integrations/mail';
import { threadNotFound } from '../../../integrations/mail-errors';
import { AgentError } from '../../errors';
import { msg, render } from '../../i18n';
import { recipientsParam } from '../email-send';
import { check, evidence, type ToolDefinition } from '../types';
import {
  EmailField,
  ProviderField,
  bindProvider,
  chosenProvider,
  connectionFor,
  optionsFor,
  requiresFor,
} from './common';

export const EmailDraftReplyInput = z.object({
  provider: ProviderField,
  threadId: z
    .string()
    .min(1)
    .max(512)
    .describe('The conversation to answer, e.g. {{s1.firstThreadId}}.'),
  to: z
    .array(EmailField)
    .min(1)
    .max(10)
    .describe(
      'Who the reply goes to, e.g. ["{{s1.firstReplyTo}}"] — a participant of the conversation.',
    ),
  subject: z.string().min(1).max(300).describe('e.g. {{s1.firstReplySubject}}.'),
  body: z.string().min(1).max(EMAIL_LIMITS.bodyMaxChars).describe('The reply text (plain text).'),
});
export type EmailDraftReplyInput = z.infer<typeof EmailDraftReplyInput>;

export const emailDraftReplyTool: ToolDefinition<EmailDraftReplyInput> = {
  id: 'email.draft_reply',
  version: '1.0.0',
  description:
    'Save a reply to an email conversation as a draft in the user’s mailbox (nothing is sent; the user reviews it). Needs the approval of the exact recipients, subject and body. Output: draftId, threadId.',
  inputSchema: EmailDraftReplyInput,
  allowedRefTools: ['email.search', 'email.read_thread'],
  outputFields: ['draftId', 'threadId'],
  requiredConnection: null,
  connectionOptions: optionsFor('mail.compose'),
  requires: requiresFor('mail.compose'),
  bind: (input, ctx) =>
    input.provider ? input : { ...input, provider: bindProvider('mail.compose', ctx) },
  permissions: ['email:compose'],
  sideEffect: 'external',
  idempotency: 'once_per_step',
  timeoutMs: 45_000,
  retry: { maxAttempts: 1, retryableCodes: [] },
  modelUse: 'none',
  riskLevel: () => 'MEDIUM',
  estimateCostMicro: () => 0,
  preview: (input) => ({
    provider: input.provider,
    threadId: input.threadId,
    to: input.to,
    subject: input.subject,
    body: truncate(input.body, 2_000),
  }),
  approvalDetails(input, ctx) {
    const provider = chosenProvider(input.provider, { has: (p) => !!ctx.accounts?.[p] });
    const summaryMessage = msg('approval.emailDraft', {
      subject: input.subject,
      recipients: recipientsParam(input.to),
    });
    return {
      details: {
        kind: 'email',
        mode: 'draft',
        via: provider,
        from: ctx.accounts?.[provider] ?? '',
        to: [...input.to],
        subject: input.subject,
        body: input.body,
        inReplyTo: { threadId: input.threadId, subject: input.subject },
      },
      summary: render(ctx.language, summaryMessage),
      summaryMessage,
    };
  },
  async execute(input, rt, signal) {
    const conn = await connectionFor(rt, input.provider, 'mail.compose');
    const client = mailClient(rt, rt.ctx, conn);
    const thread = await client.threadMeta(input.threadId, signal);
    if (!thread) throw threadNotFound();
    const participants = new Set(
      thread.messages.flatMap((m) =>
        [m.from, ...m.replyTo, ...m.to, ...m.cc].map((a) => a.address.toLowerCase()),
      ),
    );
    const outsiders = input.to.filter((a) => !participants.has(a.toLowerCase()));
    if (outsiders.length)
      throw new AgentError(
        'TOOL_FAILED',
        'A reply draft can only be addressed to people already in the conversation. Nothing was saved.',
        { retryable: false },
      );
    const draft = await client.createDraftReply(
      {
        threadId: input.threadId,
        to: input.to.map((a) => a.toLowerCase()),
        subject: input.subject,
        body: input.body,
      },
      signal,
    );
    const output = {
      provider: conn.provider,
      draftId: draft.draftId,
      threadId: draft.threadId,
      messageId: draft.messageId,
      to: input.to,
      subject: input.subject,
    };
    return {
      output,
      outputPreview: {
        provider: conn.provider,
        draftId: draft.draftId,
        to: input.to,
        subject: input.subject,
      },
      evidence: [
        evidence('provider_response', `${conn.provider} draft`, draft.draftId, 'MAIL_DRAFT', {
          provider: conn.provider,
          draftId: draft.draftId,
          threadId: draft.threadId,
        }),
      ],
      costMicro: 0,
    };
  },
  verify: (_input, output) => ({
    ok: typeof output.draftId === 'string' && output.draftId.length > 0,
    checks: [
      check('draftCreated', `Draft ${String(output.draftId)} saved`, {
        id: String(output.draftId ?? ''),
      }),
    ],
  }),
  resultLine: (input) => msg('result.draftCreated', { subject: input.subject }),
  resultFact: (input) => `Saved a reply draft “${truncate(input.subject, 120)}” (not sent).`,
  audit: (input, output) => ({
    action: 'email.draft_created',
    metadata: { provider: output.provider, recipientCount: input.to.length },
  }),
};
