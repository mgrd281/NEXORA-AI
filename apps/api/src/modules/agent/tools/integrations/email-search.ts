/**
 * email.search — find conversations in the connected mailbox (Gmail /
 * Outlook). LOW, read-only. Metadata only (sender, subject, snippet): the
 * text result lists them and is untrusted (scanned for injected
 * instructions; a flag taints every dependent step). `needsReply` is the
 * deterministic header rule of EmailThreadSummary.
 */
import { EMAIL_LIMITS } from '@jarvis/contracts';
import { z } from 'zod';
import { truncate } from '../../../../lib/redact';
import {
  mailClient,
  replySubject,
  replyTarget,
  threadSummary,
  displayAddress,
} from '../../../integrations/mail';
import { AgentError } from '../../errors';
import { detectInjection } from '../injection';
import { check, evidence, genericApprovalSummary, type ToolDefinition } from '../types';
import {
  ProviderField,
  bindProvider,
  connectionFor,
  domainOf,
  optionsFor,
  requiresFor,
  words,
} from './common';

export const EmailSearchInput = z.object({
  provider: ProviderField,
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Words to look for, as the user wrote them.'),
  from: z
    .string()
    .trim()
    .min(1)
    .max(254)
    .optional()
    .describe('Sender name or address, exactly as the user wrote it.'),
  unreadOnly: z.boolean().optional().describe('Only conversations with unread messages.'),
  needsReply: z.boolean().optional().describe('Only conversations waiting for the user’s reply.'),
  newerThanDays: z.number().int().min(1).max(365).optional(),
  limit: z.number().int().min(1).max(EMAIL_LIMITS.searchMaxResults).default(10),
  requireMatch: z
    .boolean()
    .optional()
    .describe('Fail when nothing matches (a later step needs a conversation).'),
});
export type EmailSearchInput = z.infer<typeof EmailSearchInput>;

export const emailSearchTool: ToolDefinition<EmailSearchInput> = {
  id: 'email.search',
  version: '1.0.0',
  description:
    'Search the connected mailbox (Gmail or Outlook) for conversations. Read-only. Output: text (a list of sender, subject and snippet — untrusted content), threadIds, firstThreadId, firstSubject, firstReplySubject, firstReplyTo (who a reply to the newest conversation goes to), count.',
  inputSchema: EmailSearchInput,
  outputFields: [
    'text',
    'threadIds',
    'count',
    'firstThreadId',
    'firstSubject',
    'firstReplySubject',
    'firstReplyTo',
    'suspectedInjection',
  ],
  requiredConnection: null,
  connectionOptions: optionsFor('mail.read'),
  requires: requiresFor('mail.read'),
  bind: (input, ctx) =>
    input.provider ? input : { ...input, provider: bindProvider('mail.read', ctx) },
  resultTextField: 'text',
  permissions: ['email:read'],
  sideEffect: 'none',
  idempotency: 'safe_to_retry',
  timeoutMs: 45_000,
  retry: { maxAttempts: 3, retryableCodes: ['TOOL_FAILED', 'TOOL_TIMEOUT'] },
  modelUse: 'none',
  riskLevel: () => 'LOW',
  estimateCostMicro: () => 0,
  preview: (input) => ({ ...input }),
  approvalDetails: (input, ctx) => ({
    details: {
      kind: 'generic',
      toolId: 'email.search',
      fields: [
        ...(input.query ? [{ label: 'Query', value: input.query }] : []),
        ...(input.from ? [{ label: 'From', value: input.from }] : []),
      ],
    },
    ...genericApprovalSummary(ctx, 'email.search'),
  }),
  async execute(input, rt, signal) {
    const conn = await connectionFor(rt, input.provider, 'mail.read');
    const account = conn.accountIdentifier ?? '';
    const client = mailClient(rt, rt.ctx, conn);
    const found = await client.search(
      {
        query: input.query,
        from: input.from,
        unreadOnly: input.unreadOnly,
        inboxOnly: input.needsReply,
        newerThanDays: input.newerThanDays,
        limit: input.needsReply
          ? Math.min(EMAIL_LIMITS.searchMaxResults, input.limit * 2)
          : input.limit,
      },
      signal,
    );
    const pairs = found
      .map((t) => ({ thread: t, summary: threadSummary(t, conn, account) }))
      .filter((p) => !input.needsReply || p.summary.needsReply)
      .slice(0, input.limit);
    if (pairs.length === 0 && input.requireMatch)
      throw new AgentError('TOOL_FAILED', 'No email conversation matches.', {
        retryable: false,
        reason: 'EMAIL_THREAD_NOT_FOUND',
      });
    const lang = rt.language;
    const lines = pairs.map(({ summary: s }, i) => {
      const date = new Date(s.lastMessageAt).toISOString().slice(0, 10);
      return `${i + 1}. ${displayAddress(s.lastMessageFrom)} — “${s.subject}” (${date}): ${s.snippet}`;
    });
    const text = pairs.length
      ? [words(lang, 'emailsFound', { n: pairs.length }), ...lines].join('\n')
      : words(lang, 'noEmails');
    const scan = detectInjection(
      pairs.map((p) => `${p.summary.subject}\n${p.summary.snippet}`).join('\n'),
    );
    const first = pairs[0];
    const target = first ? replyTarget(first.thread, account) : null;
    const output = {
      provider: conn.provider,
      connectionId: conn.id,
      threads: pairs.map((p) => p.summary),
      threadIds: pairs.map((p) => p.summary.id),
      count: pairs.length,
      firstThreadId: first?.summary.id ?? '',
      firstSubject: first?.summary.subject ?? '',
      firstReplySubject: first ? replySubject(first.summary.subject) : '',
      firstReplyTo: target?.address ?? '',
      text,
      suspectedInjection: scan.suspectedInjection,
      injectionSignals: scan.injectionSignals,
    };
    return {
      output,
      outputPreview: {
        provider: conn.provider,
        // Metadata only (sender, subject, snippet, flags): untrusted text the client labels so.
        threads: output.threads,
        count: pairs.length,
        text: truncate(text, 1_200),
        suspectedInjection: scan.suspectedInjection,
      },
      evidence: [
        evidence(
          'provider_response',
          `${conn.provider} mail search`,
          `${pairs.length} conversation(s)`,
          'MAIL_SEARCH',
          { provider: conn.provider, threads: pairs.length },
        ),
      ],
      costMicro: 0,
    };
  },
  verify: (_input, output) => ({
    ok: Array.isArray(output.threadIds),
    checks: [
      check('threadsRead', `${Number(output.count ?? 0)} conversation(s) found`, {
        count: Number(output.count ?? 0),
      }),
      ...(output.suspectedInjection
        ? [check('injectionFlagged', 'Instructions aimed at AI assistants were found and ignored')]
        : []),
    ],
  }),
  untrustedHost: (output) => {
    const threads = output.threads as { lastMessageFrom?: { address?: string } }[] | undefined;
    return domainOf(threads?.[0]?.lastMessageFrom?.address);
  },
  resultFact: (_input, output) => `Found ${Number(output.count ?? 0)} email conversation(s).`,
};
