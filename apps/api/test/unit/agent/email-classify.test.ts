import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/lib/errors';
import {
  classifySmtpError,
  emailSendTool,
  messageIdFor,
} from '../../../src/modules/agent/tools/email-send';

describe('email.send failure classification', () => {
  it.each([
    [{ code: 'ESOCKET', command: 'CONN' }, 'CONNECTION_FAILED', true],
    [{ code: 'ECONNECTION', command: 'CONN' }, 'CONNECTION_FAILED', true],
    [{ code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 }, 'CONNECTION_FAILED', true],
    [{ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 }, 'TOOL_FAILED', true],
    [{ code: 'EMESSAGE', command: 'DATA', responseCode: 554 }, 'TOOL_FAILED', true],
    [{ code: 'ETIMEDOUT', command: 'DATA' }, 'OUTCOME_UNKNOWN', false],
    [{ code: 'ESOCKET', command: 'DATA' }, 'OUTCOME_UNKNOWN', false],
    [new Error('weird'), 'OUTCOME_UNKNOWN', false],
  ])('%o → %s (retryable %s)', (err, code, retryable) => {
    const e = classifySmtpError(Object.assign(new Error('x'), err));
    expect(e.code).toBe(code);
    expect(e.retryable).toBe(retryable);
  });

  it('errors raised before connecting are definite failures', () => {
    const e = classifySmtpError(
      new AppError('CONNECTION_FAILED', 'Unencrypted SMTP is not allowed.'),
    );
    expect(e).toMatchObject({ code: 'CONNECTION_FAILED', retryable: true });
  });

  it('derives a deterministic Message-ID from the idempotency key', () => {
    expect(messageIdFor('step-1', 'me@example.com')).toBe(messageIdFor('step-1', 'me@example.com'));
    expect(messageIdFor('step-1', 'me@example.com')).not.toBe(
      messageIdFor('step-2', 'me@example.com'),
    );
    expect(messageIdFor('step-1', 'me@example.com')).toMatch(
      /^<jarvis\.[0-9a-f]{32}@example\.com>$/,
    );
  });

  it('is MEDIUM risk, HIGH above three recipients', () => {
    const ctx = { accountEmail: 'me@example.com' };
    const input = (n: number) => ({
      to: Array.from({ length: n }, (_, i) => `r${i}@x.test`),
      subject: 's',
      body: 'b',
    });
    expect(emailSendTool.riskLevel(input(3), ctx)).toBe('MEDIUM');
    expect(emailSendTool.riskLevel(input(4), ctx)).toBe('HIGH');
  });

  it('verify requires every recipient accepted and a 250 response', () => {
    const input = { to: ['a@x.test', 'B@x.test'], subject: 's', body: 'b' };
    expect(
      emailSendTool.verify(input, {
        accepted: ['a@x.test', 'b@x.test'],
        rejected: [],
        response: '250 OK',
        messageId: '<m>',
      }).ok,
    ).toBe(true);
    expect(
      emailSendTool.verify(input, {
        accepted: ['a@x.test'],
        rejected: ['b@x.test'],
        response: '250 OK',
        messageId: '<m>',
      }).ok,
    ).toBe(false);
    expect(
      emailSendTool.verify(input, {
        accepted: ['a@x.test', 'b@x.test'],
        rejected: [],
        response: '451 later',
        messageId: '<m>',
      }).ok,
    ).toBe(false);
  });
});
