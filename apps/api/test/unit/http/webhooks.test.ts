import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WebhookPayload, WebhookEventType, type WebhookDeliveryEventType } from '@jarvis/contracts';
import { AppError } from '../../../src/lib/errors';
import { buildWebhookPayload, deliveryJobKey } from '../../../src/modules/webhooks/emit';
import { checkWebhookUrl, webhookHost, webhookLookup } from '../../../src/modules/webhooks/url';

const config = (hosts: string[] = []) => ({ webhookAllowInsecureHosts: new Set(hosts) });
const resolveTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

async function reasonOf(
  p: Promise<unknown>,
): Promise<{ code: string; reason: unknown; host?: unknown }> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const e = err as AppError;
    return { code: e.code, reason: e.details?.reason, host: e.details?.host };
  }
  throw new Error('expected a rejection');
}

describe('checkWebhookUrl', () => {
  it('accepts https URLs whose host resolves to public addresses only', async () => {
    const url = await checkWebhookUrl('https://hooks.example.com/jarvis?x=1', config(), {
      resolve: resolveTo('93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'),
    });
    expect(url.toString()).toBe('https://hooks.example.com/jarvis?x=1');
    expect(await checkWebhookUrl('https://93.184.215.14:8443/h', config())).toBeInstanceOf(URL);
  });

  it('refuses plain http unless the host:port is allow-listed (development only)', async () => {
    expect(
      await reasonOf(
        checkWebhookUrl('http://hooks.example.com/x', config(), {
          resolve: resolveTo('93.184.215.14'),
        }),
      ),
    ).toEqual({
      code: 'FETCH_BLOCKED',
      reason: 'WEBHOOK_URL_INSECURE',
      host: undefined,
    });
    // Allow-listed: http and a private address (a local receiver) are fine.
    const url = await checkWebhookUrl('http://127.0.0.1:4555/hook', config(['127.0.0.1:4555']));
    expect(url.port).toBe('4555');
    // Same host, another port: still refused.
    expect(
      (await reasonOf(checkWebhookUrl('http://127.0.0.1:4556/hook', config(['127.0.0.1:4555']))))
        .reason,
    ).toBe('WEBHOOK_URL_INSECURE');
  });

  it('refuses credentials, fragments and non-URLs', async () => {
    for (const bad of [
      'https://user:pw@hooks.example.com/',
      'https://hooks.example.com/#frag',
      'not a url',
      'ftp://x.example.com/',
    ]) {
      expect(
        (await reasonOf(checkWebhookUrl(bad, config(), { resolve: resolveTo('93.184.215.14') })))
          .reason,
        bad,
      ).toBe('WEBHOOK_URL_INVALID');
    }
  });

  it('refuses private, loopback, link-local and reserved addresses (literal or resolved)', async () => {
    for (const host of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '[::1]',
      '[fd00::1]',
      '[::ffff:192.168.0.1]',
      '0.0.0.0',
    ]) {
      const r = await reasonOf(checkWebhookUrl(`https://${host}/hook`, config()));
      expect(r.reason, host).toBe('WEBHOOK_URL_BLOCKED');
    }
    // A name resolving to a private address, or to a mix (rebinding-style answers).
    expect(
      await reasonOf(
        checkWebhookUrl('https://internal.example.com/', config(), {
          resolve: resolveTo('10.0.0.5'),
        }),
      ),
    ).toEqual({
      code: 'FETCH_BLOCKED',
      reason: 'WEBHOOK_URL_BLOCKED',
      host: 'internal.example.com',
    });
    expect(
      (
        await reasonOf(
          checkWebhookUrl('https://mixed.example.com/', config(), {
            resolve: resolveTo('93.184.215.14', '127.0.0.1'),
          }),
        )
      ).reason,
    ).toBe('WEBHOOK_URL_BLOCKED');
  });

  it('refuses hosts that do not resolve', async () => {
    const r = await reasonOf(
      checkWebhookUrl('https://nowhere.invalid/', config(), {
        resolve: async () => {
          throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
        },
      }),
    );
    expect(r).toMatchObject({
      code: 'FETCH_BLOCKED',
      reason: 'WEBHOOK_URL_INVALID',
      host: 'nowhere.invalid',
    });
  });

  it('connects only to public addresses at delivery time (DNS-rebinding safe lookup)', async () => {
    const lookup = webhookLookup(new URL('https://localhost/hook'), config());
    const err = await new Promise<unknown>((resolve) =>
      lookup('localhost', { all: false }, (e) => resolve(e)),
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('FETCH_BLOCKED');
  });

  it('reports only the host for audit records', () => {
    expect(webhookHost('https://hooks.example.com:8443/secret/path?token=x')).toBe(
      'hooks.example.com:8443',
    );
    expect(webhookHost('nope')).toBe('');
  });
});

describe('webhook payloads', () => {
  const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  const ENUM = /^[A-Za-z_.]+$/;

  /** Every string in the payload is an id, a timestamp or an enum value — never content. */
  function assertMetadataOnly(value: unknown, path = ''): void {
    if (typeof value === 'string') {
      expect(ID.test(value) || TS.test(value) || ENUM.test(value), `${path}: ${value}`).toBe(true);
    } else if (Array.isArray(value))
      value.forEach((v, i) => assertMetadataOnly(v, `${path}[${i}]`));
    else if (value && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) assertMetadataOnly(v, `${path}.${k}`);
  }

  const taskData = {
    taskId: randomUUID(),
    conversationId: randomUUID(),
    scheduleId: null,
    status: 'COMPLETED',
    outcome: 'answer',
    riskLevel: 'MEDIUM',
    source: 'text',
    toolIds: ['web.fetch', 'text.summarize', 'email.send'],
    error: null,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  } as const;

  it('strips anything that is not part of the contract (titles, requests, bodies…)', () => {
    const payload = buildWebhookPayload({
      type: 'task.completed',
      data: {
        ...taskData,
        title: 'Summarise my bank statement',
        request: 'email the summary to boss@example.com',
        answer: 'Your balance is …',
        emailBody: 'secret content',
      },
      at: new Date('2026-11-04T10:00:00Z'),
    });
    expect(Object.keys(payload.data).sort()).toEqual(Object.keys(taskData).sort());
    expect(JSON.stringify(payload)).not.toMatch(/bank|boss@|balance|secret content/);
    assertMetadataOnly(payload);
    expect(WebhookPayload.parse(payload)).toEqual(payload);
  });

  it('builds a valid, metadata-only payload for every event type', () => {
    const approval = {
      approvalId: randomUUID(),
      taskId: randomUUID(),
      stepId: randomUUID(),
      toolId: 'email.send',
      riskLevel: 'MEDIUM',
      status: 'PENDING',
      expiresAt: new Date().toISOString(),
      decidedAt: null,
    } as const;
    const schedule = {
      scheduleId: randomUUID(),
      occurrenceAt: new Date().toISOString(),
      taskId: null,
      status: 'paused',
      consecutiveFailures: 3,
      reason: null,
    } as const;
    const all: WebhookDeliveryEventType[] = [...WebhookEventType.options, 'webhook.test'];
    for (const type of all) {
      const data = type.startsWith('task.')
        ? {
            ...taskData,
            error:
              type === 'task.failed'
                ? { code: 'TOOL_FAILED', reason: 'HTTP_ERROR', retryable: true }
                : null,
          }
        : type.startsWith('approval.')
          ? approval
          : type.startsWith('schedule.')
            ? schedule
            : { endpointId: randomUUID(), test: true };
      const payload = buildWebhookPayload({ type, data });
      expect(payload.type).toBe(type);
      assertMetadataOnly(payload);
    }
  });

  it('rejects data of the wrong shape (a caller bug, never sent)', () => {
    expect(() => buildWebhookPayload({ type: 'approval.requested', data: taskData })).toThrow();
  });

  it('keys each delivery attempt job uniquely', () => {
    expect(deliveryJobKey('d1', 1)).toBe('webhook:d1:1');
    expect(deliveryJobKey('d1', 2)).not.toBe(deliveryJobKey('d1', 1));
  });
});
