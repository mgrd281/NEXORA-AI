/**
 * email.send — send a plain-text email through the user's SMTP connection.
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
import { AgentError } from '../errors';
import { t } from '../i18n';
import { hasTemplate } from '../templates';
import { evidence, type ToolDefinition } from './types';

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
});
export type EmailSendInput = z.infer<typeof EmailSendInput>;

const PRE_DATA_COMMANDS = /^(CONN|EHLO|HELO|LHLO|STARTTLS|AUTH|MAIL|RCPT)/i;

export function messageIdFor(idempotencyKey: string, fromAddress: string): string {
  const domain = (fromAddress.split('@')[1] ?? 'jarvis.local').replace(/[^A-Za-z0-9.-]/g, '');
  return `<jarvis.${sha256Hex(`email.send:${idempotencyKey}`).slice(0, 32)}@${domain || 'jarvis.local'}>`;
}

/** Decides whether a send failure is definite (nothing was delivered) or unknown. */
export function classifySmtpError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  if (err instanceof AppError) {
    return new AgentError('CONNECTION_FAILED', err.message, { retryable: true });
  }
  const e = err as { code?: string; command?: string; responseCode?: number; response?: string };
  const command = e.command ?? '';
  if (e.code === 'EAUTH')
    return new AgentError(
      'CONNECTION_FAILED',
      'The mail server rejected the username or password. Update the email connection, then retry.',
      { retryable: true },
    );
  if (typeof e.responseCode === 'number' && e.responseCode >= 400) {
    return new AgentError(
      'TOOL_FAILED',
      `The mail server refused the message (${e.responseCode}). Nothing was sent.`,
      { retryable: true },
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
      { retryable: true },
    );
  }
  return new AgentError(
    'OUTCOME_UNKNOWN',
    'The mail server stopped responding while the email was being sent, so JARVIS cannot tell whether it was delivered. Check your Sent folder or inbox before retrying.',
    { retryable: false },
  );
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
    "Send a plain-text email from the user's connected email account. External side effect: always shown to the user for approval unless policy allows it. Output: messageId, accepted, rejected, response.",
  inputSchema: EmailSendInput,
  validatePlanned(input) {
    const issues: string[] = [];
    if (Array.isArray(input.to) && input.to.some((r) => typeof r === 'string' && hasTemplate(r)))
      issues.push(
        'email.send "to" must contain literal email addresses; references to other steps are not allowed.',
      );
    return issues;
  },
  outputFields: ['messageId', 'accepted', 'rejected', 'response'],
  requiredConnection: 'smtp',
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
  }),
  approvalDetails(input, ctx) {
    const recipients =
      input.to.length <= 2
        ? input.to.join(', ')
        : t(ctx.language, 'approval.recipientsMany', { count: input.to.length });
    return {
      details: {
        kind: 'email',
        from: ctx.fromAddress ?? '',
        to: [...input.to],
        subject: input.subject,
        body: input.body,
      },
      summary: t(ctx.language, 'approval.email', { subject: input.subject, recipients }),
    };
  },
  async execute(input, rt, signal) {
    const conn = rt.connections.get('smtp');
    if (!conn) {
      throw new AgentError('CONNECTION_REQUIRED', 'Connect an email account to send email.', {
        retryable: true,
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
      throw classifySmtpError(err);
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
    const accepted = new Set(lower(output.accepted));
    const rejected = lower(output.rejected);
    const response = String(output.response ?? '');
    const allAccepted = input.to.every((r) => accepted.has(r.toLowerCase()));
    return {
      ok: allAccepted && rejected.length === 0 && response.startsWith('250'),
      checks: [
        `${input.to.filter((r) => accepted.has(r.toLowerCase())).length}/${input.to.length} recipients accepted`,
        rejected.length ? `Rejected: ${rejected.join(', ')}` : 'No recipients rejected',
        `Server response: ${truncate(response, 120)}`,
        `Message-ID ${String(output.messageId ?? '')}`,
      ],
    };
  },
  audit: (input) => ({ action: 'email.sent', metadata: { recipientCount: input.to.length } }),
};
