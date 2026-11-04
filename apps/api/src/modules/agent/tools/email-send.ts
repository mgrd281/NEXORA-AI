/**
 * email.send — send a plain-text email through the user's SMTP connection,
 * or (Phase C, `via`) through the connected Google / Microsoft account itself
 * (Gmail API / Microsoft Graph). An absent `via` means SMTP, so stored plans
 * and approvals keep their meaning; `bind` fills it at planning (SMTP when
 * an SMTP connection is active, else the account granting mail.send, google
 * before microsoft) so the approval and its hash bind the exact account.
 *
 * Safety properties:
 *  - Recipients are literal addresses fixed at planning time; references
 *    ({{…}}) are rejected in `to`, so fetched content can never choose who
 *    receives mail.
 *  - once_per_step: one execution row per step (idempotency key = step id). A
 *    send that was interrupted is reported as OUTCOME_UNKNOWN and never
 *    repeated automatically.
 *  - Message-ID is derived from the idempotency key, so an acknowledged resend
 *    carries the same Message-ID and mail clients can de-duplicate it.
 *  - Failures are classified: before the message was handed over (connect,
 *    auth, rejected envelope) is a definite failure and safe to retry;
 *    anything ambiguous is OUTCOME_UNKNOWN.
 *  - Providers, exactly once: Gmail messages carry the Message-ID derived
 *    from the idempotency key and Sent is searched (rfc822msgid:) before
 *    every send; Graph sends carry the key as a tagged extended property and
 *    Sent Items is searched for it first. A retry after OUTCOME_UNKNOWN that
 *    the user acknowledged therefore records the message already sent
 *    instead of sending a second one.
 */
import { z } from 'zod';
import { sha256Hex } from '../../../lib/crypto';
import { AppError } from '../../../lib/errors';
import { truncate } from '../../../lib/redact';
import {
  createSmtpTransport,
  openSecret,
  type SmtpConfig,
  type SmtpSecret,
} from '../../connections/smtp';
import { mailClient } from '../../integrations/mail';
import { AgentError } from '../errors';
import { msg, render } from '../i18n';
import { hasTemplate } from '../templates';
import { connectionFor } from './integrations/common';
import {
  check,
  evidence,
  type BindContext,
  type ConnectionRequirement,
  type ToolDefinition,
  type ToolResult,
  type ToolRuntime,
} from './types';

export const EmailSendInput = z.object({
  to: z
    .array(z.email().max(254))
    .min(1)
    .max(10)
    .describe(
      'Recipient email addresses, written literally: only addresses that appear in the user\'s request, or the account owner\'s own address when the user says "me". Never references.',
    ),
  subject: z.string().min(1).max(250).describe('Subject line. May contain {{refs}}.'),
  body: z.string().min(1).max(50_000).describe('Plain-text body. May contain {{refs}}.'),
  // Phase C
  via: z
    .enum(['smtp', 'google', 'microsoft'])
    .optional()
    .describe(
      'How it is sent: the SMTP connection or the Google / Microsoft account. Leave it out: JARVIS fills it in.',
    ),
  inReplyTo: z
    .object({
      threadId: z.string().min(1).max(512).describe('The conversation, e.g. {{s1.firstThreadId}}.'),
      subject: z
        .string()
        .max(300)
        .default('')
        .describe('Its subject as read, e.g. {{s1.firstSubject}}.'),
    })
    .optional()
    .describe('Reply inside an existing conversation (Google / Microsoft only).'),
});
export type EmailSendInput = z.infer<typeof EmailSendInput>;

type Via = NonNullable<EmailSendInput['via']>;

/** The connection a send uses: `via`, absent = SMTP (older plans). */
export function sendRequirement(input: Pick<EmailSendInput, 'via'>): ConnectionRequirement {
  return input.via === 'google' || input.via === 'microsoft'
    ? { provider: input.via, capability: 'mail.send' }
    : { provider: 'smtp' };
}

/** SMTP when active, else the account granting mail.send (google first), else an expired one. */
export function bindVia(ctx: BindContext): Via | undefined {
  if (ctx.connections.some((c) => c.provider === 'smtp' && c.status === 'active')) return 'smtp';
  const oauth = ctx.connections.filter(
    (c) =>
      (c.provider === 'google' || c.provider === 'microsoft') &&
      c.capabilities.includes('mail.send'),
  );
  const pick =
    oauth.find((c) => c.status === 'active') ?? oauth.find((c) => c.status === 'expired');
  return pick?.provider as Via | undefined;
}

const PRE_DATA_COMMANDS = /^(CONN|EHLO|HELO|LHLO|STARTTLS|AUTH|MAIL|RCPT)/i;

export function messageIdFor(idempotencyKey: string, fromAddress: string): string {
  const domain = (fromAddress.split('@')[1] ?? 'jarvis.local').replace(/[^A-Za-z0-9.-]/g, '');
  return `<jarvis.${sha256Hex(`email.send:${idempotencyKey}`).slice(0, 32)}@${domain || 'jarvis.local'}>`;
}

/** Decides whether a send failure is definite (nothing was delivered) or unknown. */
export function classifySmtpError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  if (err instanceof AppError) {
    return new AgentError('CONNECTION_FAILED', err.message, {
      retryable: true,
      reason: 'SMTP_UNUSABLE',
    });
  }
  const e = err as { code?: string; command?: string; responseCode?: number; response?: string };
  const command = e.command ?? '';
  if (e.code === 'EAUTH')
    return new AgentError(
      'CONNECTION_FAILED',
      'The mail server rejected the username or password. Update the email connection, then retry.',
      { retryable: true, reason: 'SMTP_AUTH' },
    );
  if (typeof e.responseCode === 'number' && e.responseCode >= 400) {
    return new AgentError(
      'TOOL_FAILED',
      `The mail server refused the message (${e.responseCode}). Nothing was sent.`,
      { retryable: true, reason: 'SMTP_REFUSED', params: { responseCode: e.responseCode } },
    );
  }
  if (
    e.code === 'ECONNECTION' ||
    e.code === 'EDNS' ||
    e.code === 'ETLS' ||
    ((e.code === 'ESOCKET' || e.code === 'ETIMEDOUT') && PRE_DATA_COMMANDS.test(command))
  ) {
    return new AgentError(
      'CONNECTION_FAILED',
      'Could not connect to the mail server. Nothing was sent; you can retry.',
      { retryable: true, reason: 'SMTP_CONNECT' },
    );
  }
  return new AgentError(
    'OUTCOME_UNKNOWN',
    'The mail server stopped responding while the email was being sent, so JARVIS cannot tell whether it was delivered. Check your Sent folder or inbox before retrying.',
    { retryable: false, reason: 'SEND_INTERRUPTED' },
  );
}

/** The recipients of a summary sentence: the addresses, or "N recipients" beyond two. */
export function recipientsParam(to: readonly string[]) {
  return to.length <= 2 ? to.join(', ') : msg('approval.recipientsMany', { count: to.length });
}

const lower = (xs: unknown): string[] =>
  Array.isArray(xs)
    ? xs.map((x) =>
        String(
          typeof x === 'object' && x ? ((x as { address?: string }).address ?? '') : x,
        ).toLowerCase(),
      )
    : [];

export const emailSendTool: ToolDefinition<EmailSendInput> = {
  id: 'email.send',
  version: '1.0.0',
  description:
    "Send a plain-text email from the user's connected email account (SMTP, or the Google / Microsoft account: `via`; JARVIS fills it in). External side effect: always shown to the user for approval unless policy allows it. Output: messageId, accepted, rejected, response, threadId (Google / Microsoft).",
  inputSchema: EmailSendInput,
  validatePlanned(input) {
    const issues: string[] = [];
    if (Array.isArray(input.to) && input.to.some((r) => typeof r === 'string' && hasTemplate(r)))
      issues.push(
        'email.send "to" must contain literal email addresses; references to other steps are not allowed.',
      );
    if (input.via === 'smtp' && input.inReplyTo)
      issues.push('email.send "inReplyTo" needs a Google or Microsoft account (via), not SMTP.');
    return issues;
  },
  outputFields: ['messageId', 'accepted', 'rejected', 'response', 'threadId'],
  requiredConnection: null,
  // Phase C: SMTP, or a Google / Microsoft account granting mail.send.
  connectionOptions: [
    { provider: 'smtp' },
    { provider: 'google', capability: 'mail.send' },
    { provider: 'microsoft', capability: 'mail.send' },
  ],
  requires: (input) => sendRequirement(input),
  bind: (input, ctx) => {
    if (input.via) return input;
    const via = bindVia(ctx);
    return via ? { ...input, via } : input;
  },
  permissions: ['email:send'],
  sideEffect: 'external',
  idempotency: 'once_per_step',
  timeoutMs: 45_000,
  retry: { maxAttempts: 1, retryableCodes: [] },
  modelUse: 'none',
  riskLevel: (input) => (input.to.length > 3 ? 'HIGH' : 'MEDIUM'),
  recipients: (input) => [...input.to],
  estimateCostMicro: () => 0,
  preview: (input) => ({
    to: input.to,
    subject: input.subject,
    body: truncate(input.body, 2_000),
    ...(input.via ? { via: input.via } : {}),
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
  }),
  approvalDetails(input, ctx) {
    const summaryMessage = msg('approval.email', {
      subject: input.subject,
      recipients: recipientsParam(input.to),
    });
    const provider = input.via === 'google' || input.via === 'microsoft' ? input.via : null;
    return {
      details: {
        kind: 'email',
        from: provider ? (ctx.accounts?.[provider] ?? '') : (ctx.fromAddress ?? ''),
        to: [...input.to],
        subject: input.subject,
        body: input.body,
        // Phase C: how it is sent (absent on SMTP sends of older plans).
        ...(input.via ? { mode: 'send' as const, via: input.via } : {}),
        ...(provider
          ? {
              inReplyTo: input.inReplyTo
                ? { threadId: input.inReplyTo.threadId, subject: input.inReplyTo.subject }
                : null,
            }
          : {}),
      },
      summary: render(ctx.language, summaryMessage),
      summaryMessage,
    };
  },
  async execute(input, rt, signal) {
    if (input.via === 'google' || input.via === 'microsoft')
      return sendViaProvider(input, input.via, rt, signal);
    if (input.inReplyTo)
      throw new AgentError(
        'TOOL_FAILED',
        'Replying inside a conversation needs a Google or Microsoft account.',
        {
          retryable: false,
        },
      );
    const conn = rt.connections.get('smtp');
    if (!conn) {
      throw new AgentError('CONNECTION_REQUIRED', 'Connect an email account to send email.', {
        retryable: true,
        reason: 'EMAIL_NOT_CONNECTED',
      });
    }
    const cfg = conn.config as unknown as SmtpConfig;
    let transport: Awaited<ReturnType<typeof createSmtpTransport>>;
    try {
      transport = await createSmtpTransport(
        cfg,
        openSecret<SmtpSecret>(rt.secrets, conn),
        rt.config,
      );
    } catch (err) {
      // Nothing has been sent at this point (secret decryption, SSRF check, transport
      // setup), so the failure is definite and never OUTCOME_UNKNOWN.
      const classified = classifySmtpError(err);
      throw classified.code === 'OUTCOME_UNKNOWN'
        ? new AgentError(
            'CONNECTION_FAILED',
            'The saved email connection could not be used. Reconnect the email account, then retry. Nothing was sent.',
            { retryable: true, reason: 'SMTP_UNUSABLE' },
          )
        : classified;
    }
    const messageId = messageIdFor(rt.idempotencyKey, cfg.fromAddress);
    const subject = input.subject.replace(/[\r\n]+/g, ' ').trim();
    try {
      const info = await new Promise<{
        messageId?: string;
        accepted?: unknown[];
        rejected?: unknown[];
        response?: string;
      }>((resolve, reject) => {
        const onAbort = () =>
          reject(
            new AgentError(
              'OUTCOME_UNKNOWN',
              'Sending the email took too long, so JARVIS cannot tell whether it was delivered. Check your Sent folder or inbox before retrying.',
              { reason: 'SEND_TIMEOUT' },
            ),
          );
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        transport
          .sendMail({
            from: cfg.fromName ? { name: cfg.fromName, address: cfg.fromAddress } : cfg.fromAddress,
            to: input.to,
            subject,
            text: input.body,
            messageId,
          })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', onAbort));
      });
      const output = {
        messageId: info.messageId || messageId,
        accepted: lower(info.accepted),
        rejected: lower(info.rejected),
        response: String(info.response ?? ''),
        from: cfg.fromAddress,
        to: input.to,
        subject,
      };
      const code = output.response.slice(0, 3);
      return {
        output,
        outputPreview: {
          messageId: output.messageId,
          accepted: output.accepted,
          rejected: output.rejected,
          response: truncate(output.response, 200),
        },
        evidence: [
          evidence(
            'smtp_receipt',
            `SMTP ${code} · ${output.accepted.length} accepted`,
            `${truncate(output.response, 300)} · Message-ID ${output.messageId}`,
            'SMTP_RECEIPT',
            {
              replyCode: code,
              accepted: output.accepted.length,
              total: input.to.length,
              response: truncate(output.response, 300),
              messageId: output.messageId,
            },
          ),
        ],
        costMicro: 0,
      };
    } catch (err) {
      throw classifySmtpError(err);
    } finally {
      transport.close();
    }
  },
  verify(input, output) {
    if (output.via === 'google' || output.via === 'microsoft') {
      const id = String(output.messageId ?? '');
      const accepted = new Set(lower(output.accepted));
      const n = input.to.filter((r) => accepted.has(r.toLowerCase())).length;
      return {
        ok: id.length > 0 && n === input.to.length,
        checks: [
          check('providerAccepted', `${String(output.via)} accepted the message ${id}`, {
            provider: String(output.via),
            id,
          }),
          check('recipientsAccepted', `${n}/${input.to.length} recipients accepted`, {
            accepted: n,
            count: input.to.length,
          }),
          check('messageId', `Message-ID ${String(output.internetMessageId ?? '')}`, {
            id: String(output.internetMessageId ?? ''),
          }),
        ],
      };
    }
    const accepted = new Set(lower(output.accepted));
    const rejected = lower(output.rejected);
    const response = String(output.response ?? '');
    const allAccepted = input.to.every((r) => accepted.has(r.toLowerCase()));
    const acceptedCount = input.to.filter((r) => accepted.has(r.toLowerCase())).length;
    const shortResponse = truncate(response, 120);
    const messageId = String(output.messageId ?? '');
    return {
      ok: allAccepted && rejected.length === 0 && response.startsWith('250'),
      checks: [
        check('recipientsAccepted', `${acceptedCount}/${input.to.length} recipients accepted`, {
          accepted: acceptedCount,
          count: input.to.length,
        }),
        rejected.length
          ? check('rejected', `Rejected: ${rejected.join(', ')}`, { list: rejected.join(', ') })
          : check('noneRejected', 'No recipients rejected'),
        check('serverResponse', `Server response: ${shortResponse}`, { response: shortResponse }),
        check('messageId', `Message-ID ${messageId}`, { id: messageId }),
      ],
    };
  },
  audit: (input, output) => ({
    action: 'email.sent',
    metadata: {
      recipientCount: input.to.length,
      ...(input.via ? { via: input.via } : {}),
      ...(output.reconciled ? { reconciled: true } : {}),
    },
  }),
};

/** Phase C: send through the Gmail API / Microsoft Graph, exactly once (see the file header). */
async function sendViaProvider(
  input: EmailSendInput,
  provider: 'google' | 'microsoft',
  rt: ToolRuntime,
  signal: AbortSignal,
): Promise<ToolResult> {
  const conn = await connectionFor(rt, provider, 'mail.send');
  const from = conn.accountIdentifier ?? '';
  const messageId = messageIdFor(rt.idempotencyKey, from);
  const subject = input.subject.replace(/[\r\n]+/g, ' ').trim();
  const sent = await mailClient(rt, rt.ctx, conn).send(
    {
      from,
      to: input.to.map((a) => a.toLowerCase()),
      cc: [],
      subject,
      body: input.body,
      messageIdHeader: messageId,
      key: rt.idempotencyKey,
      threadId: input.inReplyTo?.threadId ?? null,
    },
    signal,
  );
  const output = {
    via: provider,
    messageId: sent.messageId,
    internetMessageId: sent.internetMessageId ?? messageId,
    threadId: sent.threadId ?? '',
    accepted: input.to.map((a) => a.toLowerCase()),
    rejected: [] as string[],
    response: sent.reconciled ? 'already sent (found in Sent)' : 'accepted',
    reconciled: sent.reconciled,
    from,
    to: input.to,
    subject,
  };
  return {
    output,
    outputPreview: {
      via: provider,
      messageId: output.messageId,
      threadId: output.threadId,
      accepted: output.accepted,
      reconciled: sent.reconciled,
    },
    evidence: [
      evidence('provider_response', `${provider} sent`, output.messageId, 'MAIL_SENT', {
        provider,
        messageId: output.messageId,
        threadId: output.threadId,
      }),
    ],
    costMicro: 0,
  };
}
