import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  WEBHOOK_LIMITS,
  WebhookPayload,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEndpointWithSecret,
} from '@jarvis/contracts';
import { withContext } from '../../../src/db/pool';
import { emitWebhookEvent } from '../../../src/modules/webhooks/emit';
import {
  verifyWebhook,
  webhookHeaders,
  webhookMessageId,
  webhookSecretAad,
} from '../../../src/modules/webhooks/signing';
import { testSecrets } from '../helpers';
import { createHarness, newClient, ownerQuery, type Client, type Harness } from './support';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

// A public address literal: no DNS needed in the test environment.
const URL_OK = 'https://93.184.215.14/hooks/jarvis';

async function create(c: Client, body: Record<string, unknown> = {}) {
  return c.request('POST', '/v1/webhooks', {
    url: URL_OK,
    eventTypes: ['task.completed', 'task.failed'],
    description: 'Zapier',
    ...body,
  });
}

async function created(
  c: Client,
  body: Record<string, unknown> = {},
): Promise<WebhookEndpointWithSecret> {
  const res = await create(c, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<WebhookEndpointWithSecret>();
}

async function storedSecret(c: Client, id: string): Promise<string> {
  const row = await withContext(h.db, c.user, (trx) =>
    trx
      .selectFrom('webhook_endpoints')
      .select('secret_ciphertext')
      .where('id', '=', id)
      .executeTakeFirstOrThrow(),
  );
  return testSecrets(h.config).open(row.secret_ciphertext, webhookSecretAad(c.user.userId, id));
}

describe('endpoints', () => {
  it('returns the signing secret exactly once, sealed at rest', async () => {
    const c = await newClient(h);
    const { endpoint, secret } = await created(c);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(endpoint).toMatchObject({
      url: URL_OK,
      description: 'Zapier',
      eventTypes: ['task.completed', 'task.failed'],
      status: 'active',
      disabledReason: null,
      consecutiveFailures: 0,
      secretHint: `whsec_…${secret.slice(-4)}`,
    });
    expect(await storedSecret(c, endpoint.id)).toBe(secret);

    // Never again: not in the list, an update, or the audit log.
    const list = await c.request('GET', '/v1/webhooks');
    expect(list.json<{ items: WebhookEndpoint[] }>().items).toEqual([endpoint]);
    expect(list.body).not.toContain(secret);
    const upd = await c.request('PATCH', `/v1/webhooks/${endpoint.id}`, { description: 'Renamed' });
    expect(upd.body).not.toContain(secret);
    const audits = await ownerQuery<{ action: string; metadata: Record<string, unknown> }>(
      'SELECT action, metadata FROM audit_events WHERE target_id = $1 ORDER BY id',
      [endpoint.id],
    );
    expect(audits.map((a) => a.action)).toEqual(['webhook.created', 'webhook.updated']);
    expect(audits[0]!.metadata).toEqual({
      host: '93.184.215.14',
      eventTypes: ['task.completed', 'task.failed'],
    });
    expect(JSON.stringify(audits)).not.toContain(secret);
    expect(JSON.stringify(audits)).not.toContain('/hooks/jarvis');
    // Not stored for idempotent replay either (create is not idempotent).
    const keys = await ownerQuery(
      'SELECT 1 FROM idempotency_keys WHERE response_body::text LIKE $1',
      [`%${secret}%`],
    );
    expect(keys).toEqual([]);

    // The secret signs deliveries the Standard Webhooks way.
    const body = JSON.stringify({ type: 'webhook.test' });
    const headers = webhookHeaders(
      secret,
      webhookMessageId(randomUUID()),
      Math.floor(Date.now() / 1000),
      body,
    );
    expect(verifyWebhook(secret, headers, body)).toBe(true);
  });

  it('rotates the secret: the new one is returned once and replaces the old', async () => {
    const c = await newClient(h);
    const { endpoint, secret } = await created(c);
    const res = await c.request('POST', `/v1/webhooks/${endpoint.id}/rotate-secret`);
    expect(res.statusCode).toBe(200);
    const rotated = res.json<WebhookEndpointWithSecret>();
    expect(rotated.secret).not.toBe(secret);
    expect(rotated.endpoint.secretHint).toBe(`whsec_…${rotated.secret.slice(-4)}`);
    expect(await storedSecret(c, endpoint.id)).toBe(rotated.secret);
    // A second rotation is another new secret (not a replay).
    const again = (
      await c.request('POST', `/v1/webhooks/${endpoint.id}/rotate-secret`)
    ).json<WebhookEndpointWithSecret>();
    expect(again.secret).not.toBe(rotated.secret);
  });

  it('refuses insecure, private and malformed URLs (SSRF guard)', async () => {
    const c = await newClient(h);
    const cases: [string, string][] = [
      ['http://93.184.215.14/hook', 'WEBHOOK_URL_INSECURE'],
      ['https://127.0.0.1/hook', 'WEBHOOK_URL_BLOCKED'],
      ['https://169.254.169.254/latest/meta-data', 'WEBHOOK_URL_BLOCKED'],
      ['https://[::1]/hook', 'WEBHOOK_URL_BLOCKED'],
      ['https://localhost/hook', 'WEBHOOK_URL_BLOCKED'],
      ['https://user:pass@93.184.215.14/hook', 'WEBHOOK_URL_INVALID'],
      ['https://93.184.215.14/hook#x', 'WEBHOOK_URL_INVALID'],
    ];
    for (const [url, reason] of cases) {
      const res = await create(c, { url });
      expect(res.statusCode, url).toBe(422);
      expect(res.json().error, url).toMatchObject({ code: 'FETCH_BLOCKED', details: { reason } });
    }
    expect((await create(c, { url: 'ftp://93.184.215.14/x' })).statusCode).toBe(400);
    expect((await create(c, { eventTypes: [] })).statusCode).toBe(400);
    expect((await create(c, { eventTypes: ['task.completed', 'task.completed'] })).statusCode).toBe(
      400,
    );
    expect((await create(c, { eventTypes: ['webhook.test'] })).statusCode).toBe(400);
    // An update re-validates the URL.
    const { endpoint } = await created(c);
    const upd = await c.request('PATCH', `/v1/webhooks/${endpoint.id}`, {
      url: 'https://10.0.0.1/',
    });
    expect(upd.json().error.details.reason).toBe('WEBHOOK_URL_BLOCKED');
  });

  it('allows plain http to allow-listed development hosts only', async () => {
    const dev = await createHarness({ env: { WEBHOOK_ALLOW_INSECURE_HOSTS: '127.0.0.1:4599' } });
    try {
      const c = await newClient(dev);
      const ok = await c.request('POST', '/v1/webhooks', {
        url: 'http://127.0.0.1:4599/in',
        eventTypes: ['task.created'],
      });
      expect(ok.statusCode, ok.body).toBe(201);
      const other = await c.request('POST', '/v1/webhooks', {
        url: 'http://127.0.0.1:4600/in',
        eventTypes: ['task.created'],
      });
      expect(other.statusCode).toBe(422);
    } finally {
      await dev.close();
    }
  });

  it(`caps endpoints per user at ${WEBHOOK_LIMITS.maxEndpointsPerUser}`, async () => {
    const c = await newClient(h);
    for (let i = 0; i < WEBHOOK_LIMITS.maxEndpointsPerUser; i++)
      await created(c, { description: `n${i}` });
    const res = await create(c);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toEqual({
      reason: 'WEBHOOK_LIMIT_REACHED',
      max: WEBHOOK_LIMITS.maxEndpointsPerUser,
    });
  });

  it('disables and re-enables (failures reset); a disabled endpoint receives nothing', async () => {
    const c = await newClient(h);
    const { endpoint } = await created(c);
    await withContext(h.db, c.user, (trx) =>
      trx
        .updateTable('webhook_endpoints')
        .set({ consecutive_failures: 4 })
        .where('id', '=', endpoint.id)
        .execute(),
    );
    const off = (
      await c.request('PATCH', `/v1/webhooks/${endpoint.id}`, { enabled: false })
    ).json<WebhookEndpoint>();
    expect(off).toMatchObject({ status: 'disabled', disabledReason: 'user' });
    const test = await c.request('POST', `/v1/webhooks/${endpoint.id}/test`);
    expect(test.statusCode).toBe(409);
    expect(test.json().error.details.reason).toBe('WEBHOOK_DISABLED');
    const on = (
      await c.request('PATCH', `/v1/webhooks/${endpoint.id}`, { enabled: true })
    ).json<WebhookEndpoint>();
    expect(on).toMatchObject({ status: 'active', disabledReason: null, consecutiveFailures: 0 });
  });
});

describe('deliveries', () => {
  it('queues a signed test delivery (and its job) and lists the log newest first', async () => {
    const c = await newClient(h);
    const { endpoint } = await created(c);
    const res = await c.request('POST', `/v1/webhooks/${endpoint.id}/test`);
    expect(res.statusCode).toBe(202);
    const d = res.json<WebhookDelivery>();
    expect(d).toMatchObject({
      endpointId: endpoint.id,
      eventType: 'webhook.test',
      webhookId: `msg_${d.id}`,
      status: 'pending',
      attempts: 0,
      maxAttempts: WEBHOOK_LIMITS.maxAttempts,
      responseStatus: null,
      failureReason: null,
    });
    const job = await withContext(h.db, c.user, (trx) =>
      trx
        .selectFrom('jobs')
        .select(['kind', 'payload', 'dedupe_key', 'max_attempts'])
        .where('user_id', '=', c.user.userId)
        .executeTakeFirstOrThrow(),
    );
    expect(job).toEqual({
      kind: 'webhook.deliver',
      payload: { deliveryId: d.id },
      dedupe_key: `webhook:${d.id}:1`,
      max_attempts: 3,
    });
    const stored = await withContext(h.db, c.user, (trx) =>
      trx
        .selectFrom('webhook_deliveries')
        .select('payload')
        .where('id', '=', d.id)
        .executeTakeFirstOrThrow(),
    );
    expect(WebhookPayload.parse(stored.payload)).toMatchObject({
      type: 'webhook.test',
      data: { endpointId: endpoint.id, test: true },
    });

    const second = (
      await c.request('POST', `/v1/webhooks/${endpoint.id}/test`)
    ).json<WebhookDelivery>();
    const page1 = (await c.request('GET', `/v1/webhooks/${endpoint.id}/deliveries?limit=1`)).json<{
      items: WebhookDelivery[];
      nextCursor: string | null;
    }>();
    expect(page1.items.map((x) => x.id)).toEqual([second.id]);
    const page2 = (
      await c.request(
        'GET',
        `/v1/webhooks/${endpoint.id}/deliveries?limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      )
    ).json<{ items: WebhookDelivery[]; nextCursor: string | null }>();
    expect(page2.items.map((x) => x.id)).toEqual([d.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it('emits one delivery per subscribed active endpoint and occurrence, metadata only', async () => {
    const c = await newClient(h);
    const sub = (await created(c, { eventTypes: ['task.completed'] })).endpoint;
    const notSub = (await created(c, { eventTypes: ['approval.requested'] })).endpoint;
    const disabled = (await created(c, { eventTypes: ['task.completed'] })).endpoint;
    await c.request('PATCH', `/v1/webhooks/${disabled.id}`, { enabled: false });
    const taskId = randomUUID();
    const event = {
      type: 'task.completed' as const,
      occurrenceKey: `${taskId}:1`,
      data: {
        taskId,
        conversationId: randomUUID(),
        scheduleId: null,
        status: 'COMPLETED' as const,
        outcome: 'action' as const,
        riskLevel: 'MEDIUM' as const,
        source: 'text' as const,
        toolIds: ['email.send' as const],
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        // Not in the contract: must never reach the payload.
        title: 'Email my lawyer about the divorce',
      } as never,
    };
    const first = await withContext(h.db, c.user, (trx) => emitWebhookEvent(trx, c.user, event));
    const again = await withContext(h.db, c.user, (trx) => emitWebhookEvent(trx, c.user, event));
    expect([first, again]).toEqual([1, 0]);
    const rows = await withContext(h.db, c.user, (trx) =>
      trx
        .selectFrom('webhook_deliveries')
        .select(['endpoint_id', 'event_key', 'payload'])
        .execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endpoint_id).toBe(sub.id);
    expect(rows[0]!.event_key).toBe(`task.completed:${taskId}:1`);
    expect(JSON.stringify(rows[0]!.payload)).not.toContain('divorce');
    expect(WebhookPayload.parse(rows[0]!.payload).type).toBe('task.completed');
    expect(notSub.id).not.toBe(sub.id);
    // Another user's endpoints never receive this user's events.
    const other = await newClient(h);
    await created(other, { eventTypes: ['task.completed'] });
    const none = await withContext(h.db, c.user, (trx) =>
      emitWebhookEvent(trx, c.user, { ...event, occurrenceKey: `${taskId}:2` }),
    );
    expect(none).toBe(1);
  });

  it('deletes an endpoint with its delivery log', async () => {
    const c = await newClient(h);
    const { endpoint } = await created(c);
    await c.request('POST', `/v1/webhooks/${endpoint.id}/test`);
    expect((await c.request('DELETE', `/v1/webhooks/${endpoint.id}`)).statusCode).toBe(204);
    expect((await c.request('GET', `/v1/webhooks/${endpoint.id}/deliveries`)).statusCode).toBe(404);
    const left = await withContext(h.db, c.user, (trx) =>
      trx.selectFrom('webhook_deliveries').select('id').execute(),
    );
    expect(left).toEqual([]);
  });
});

describe('isolation', () => {
  it("hides other users' endpoints (404) on every route", async () => {
    const owner = await newClient(h);
    const other = await newClient(h);
    const { endpoint } = await created(owner);
    for (const [method, url, body] of [
      ['PATCH', `/v1/webhooks/${endpoint.id}`, { enabled: false }],
      ['DELETE', `/v1/webhooks/${endpoint.id}`, undefined],
      ['POST', `/v1/webhooks/${endpoint.id}/rotate-secret`, undefined],
      ['POST', `/v1/webhooks/${endpoint.id}/test`, undefined],
      ['GET', `/v1/webhooks/${endpoint.id}/deliveries`, undefined],
    ] as const) {
      const res = await other.request(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await other.request('GET', '/v1/webhooks')).json<{ items: unknown[] }>().items).toEqual(
      [],
    );
    expect(
      (await owner.request('GET', '/v1/webhooks')).json<{ items: WebhookEndpoint[] }>().items[0]!
        .status,
    ).toBe('active');
  });
});
