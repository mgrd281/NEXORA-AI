/**
 * Outbound webhooks end to end: task and approval lifecycle events fan out to
 * subscribed endpoints exactly once per event; deliveries are signed per
 * Standard Webhooks (checked by an independent verifier), carry ids and
 * metadata only, keep the same webhook-id and body across retries, back off,
 * succeed after a failure, refuse private addresses at delivery time, treat
 * redirects as failures, and disable an endpoint after repeated failed
 * deliveries (with a notification).
 */
import { WEBHOOK_LIMITS, WebhookPayload, type WebhookEventType } from '@jarvis/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withContext, type DbContext } from '../../../src/db/pool';
import { runOnce } from '../../../src/worker';
import {
  generateWebhookSecret,
  webhookSecretAad,
  webhookSecretHint,
} from '../../../src/modules/webhooks/signing';
import {
  startWebhookReceiver,
  verifyStandardWebhook,
  type WebhookReceiver,
} from '../../fixtures/webhook-receiver';
import {
  connectSmtp,
  createHarness,
  detail,
  drain,
  makeAllJobsDue,
  newUser,
  type Harness,
} from './harness';

let h: Harness;
let receiver: WebhookReceiver;
beforeAll(async () => {
  receiver = await startWebhookReceiver();
  h = await createHarness({ env: { WEBHOOK_ALLOW_INSECURE_HOSTS: receiver.hostPort } });
});
afterAll(async () => {
  await h.close();
  await receiver.close();
});
beforeEach(() => {
  receiver.received.length = 0;
  receiver.respond([], 200);
});

async function endpoint(user: DbContext, url: string, eventTypes: WebhookEventType[]) {
  const secret = generateWebhookSecret();
  const row = await withContext(h.db, user, async (trx) => {
    const r = await trx
      .insertInto('webhook_endpoints')
      .values({
        tenant_id: user.tenantId,
        user_id: user.userId,
        url,
        event_types: eventTypes,
        secret_ciphertext: Buffer.from([0]),
        secret_key_id: h.secrets.keyId,
        secret_hint: webhookSecretHint(secret),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // Sealed with the AAD bound to the user and this endpoint (as the HTTP layer does).
    await trx
      .updateTable('webhook_endpoints')
      .set({ secret_ciphertext: h.secrets.seal(secret, webhookSecretAad(user.userId, r.id)) })
      .where('id', '=', r.id)
      .execute();
    return r;
  });
  return { id: row.id, secret };
}

async function deliveries(user: DbContext, endpointId: string) {
  return withContext(h.db, user, (trx) =>
    trx
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('endpoint_id', '=', endpointId)
      .orderBy('created_at')
      .execute(),
  );
}

async function endpointRow(user: DbContext, id: string) {
  return withContext(h.db, user, (trx) =>
    trx.selectFrom('webhook_endpoints').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
  );
}

/** Drains, making retries due, until no delivery of the endpoint is pending. */
async function settle(user: DbContext, endpointId: string, rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await drain(h.worker);
    const pending = (await deliveries(user, endpointId)).filter((d) => d.status === 'pending');
    if (pending.length === 0) return;
    await makeAllJobsDue(h.db);
  }
  throw new Error('deliveries did not settle');
}

describe('delivery', () => {
  it('fans out task events once each, signed per Standard Webhooks, metadata only', async () => {
    const user = await newUser(h.db);
    const ep = await endpoint(user, receiver.url('/hook'), [
      'task.created',
      'task.completed',
      'task.failed',
    ]);
    const request = 'remember that my locker code is 8812';
    const task = await h.services.tasks.create(user, { request, source: 'text' }, {});
    await drain(h.worker);
    expect((await detail(h.db, user, task.id)).status).toBe('COMPLETED');

    const rows = await deliveries(user, ep.id);
    expect(rows.map((d) => [d.event_type, d.event_key, d.status, d.attempts])).toEqual([
      ['task.created', `task.created:${task.id}:1`, 'succeeded', 1],
      ['task.completed', `task.completed:${task.id}:1`, 'succeeded', 1],
    ]);
    expect(receiver.received).toHaveLength(2);
    for (const [i, got] of receiver.received.entries()) {
      expect(got.path).toBe('/hook');
      expect(got.headers['content-type']).toBe('application/json');
      expect(got.headers['user-agent']).toBe(`JARVIS-Webhooks/${h.config.APP_VERSION}`);
      expect(got.headers['webhook-id']).toBe(`msg_${rows[i]!.id}`);
      expect(verifyStandardWebhook(ep.secret, got.headers, got.body)).toBe(true);
      // A different secret or a changed body does not verify.
      expect(verifyStandardWebhook(generateWebhookSecret(), got.headers, got.body)).toBe(false);
      expect(verifyStandardWebhook(ep.secret, got.headers, `${got.body} `)).toBe(false);
      const payload = WebhookPayload.parse(JSON.parse(got.body));
      expect(payload.data).toMatchObject({ taskId: task.id });
      // Never content: no request text, no memory, no title.
      expect(got.body).not.toContain('8812');
      expect(got.body).not.toContain('locker');
    }
    const completed = JSON.parse(receiver.received[1]!.body);
    expect(completed).toMatchObject({
      type: 'task.completed',
      data: {
        status: 'COMPLETED',
        outcome: 'action',
        toolIds: ['memory.save'],
        source: 'text',
        error: null,
      },
    });
    const ep1 = await endpointRow(user, ep.id);
    expect(ep1).toMatchObject({ consecutive_failures: 0, status: 'active' });
    expect(ep1.last_success_at).not.toBeNull();

    // Emitting the same event again (a re-run) creates no second delivery.
    const { emitTaskWebhook } = await import('../../../src/modules/agent/webhook-events');
    await withContext(h.db, user, async (trx) => {
      const row = await trx
        .selectFrom('tasks')
        .selectAll()
        .where('id', '=', task.id)
        .executeTakeFirstOrThrow();
      expect(await emitTaskWebhook(trx, user, 'task.completed', row)).toBe(0);
    });
  });

  it('approval events carry ids and status, not the email', async () => {
    const user = await newUser(h.db);
    await connectSmtp(h.db, h.secrets, user, h.smtp.port);
    const ep = await endpoint(user, receiver.url('/approvals'), [
      'approval.requested',
      'approval.decided',
    ]);
    const task = await h.services.tasks.create(
      user,
      { request: 'email me: the gate code is 4471', source: 'text' },
      {},
    );
    await drain(h.worker);
    const waiting = await detail(h.db, user, task.id);
    const approval = waiting.approvals[0]!;
    await h.services.approvals.decide(
      user,
      approval.id,
      { decision: 'reject', actionHash: approval.actionHash },
      'web',
    );
    await drain(h.worker);
    const bodies = receiver.received.map((r) => JSON.parse(r.body));
    expect(bodies.map((b) => [b.type, b.data.status])).toEqual([
      ['approval.requested', 'PENDING'],
      ['approval.decided', 'REJECTED'],
    ]);
    expect(bodies[0].data).toEqual({
      approvalId: approval.id,
      taskId: task.id,
      stepId: approval.stepId,
      toolId: 'email.send',
      riskLevel: 'MEDIUM',
      status: 'PENDING',
      expiresAt: approval.expiresAt,
      decidedAt: null,
    });
    for (const r of receiver.received) {
      expect(r.body).not.toContain('4471');
      expect(r.body).not.toContain(user.email);
    }
    expect(await deliveries(user, ep.id)).toHaveLength(2);
  });

  it('retries with backoff, keeping webhook-id and body, then succeeds', async () => {
    const user = await newUser(h.db);
    const ep = await endpoint(user, receiver.url('/flaky'), ['task.failed']);
    receiver.respond([500], 200);
    const task = await h.services.tasks.create(
      user,
      { request: 'tell me a joke', source: 'text' },
      {},
    );
    await drain(h.worker);
    let [d] = await deliveries(user, ep.id);
    expect(d).toMatchObject({
      status: 'pending',
      attempts: 1,
      response_status: 500,
      failure_reason: 'HTTP_ERROR',
    });
    const delay = d!.next_attempt_at!.getTime() - d!.last_attempt_at!.getTime();
    expect(delay).toBe(WEBHOOK_LIMITS.retryDelaysSeconds[0]! * 1000);
    // Not due yet: nothing is sent.
    await drain(h.worker);
    expect(receiver.received).toHaveLength(1);
    await makeAllJobsDue(h.db);
    await drain(h.worker);
    [d] = await deliveries(user, ep.id);
    expect(d).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      response_status: 200,
      failure_reason: null,
    });
    const [first, second] = receiver.received;
    expect(second!.headers['webhook-id']).toBe(first!.headers['webhook-id']);
    expect(second!.body).toBe(first!.body);
    expect(verifyStandardWebhook(ep.secret, second!.headers, second!.body)).toBe(true);
    expect(JSON.parse(first!.body)).toMatchObject({
      type: 'task.failed',
      data: {
        taskId: task.id,
        error: { code: 'PLANNER_UNSUPPORTED', reason: 'OFFLINE_UNSUPPORTED', retryable: false },
      },
    });
    // The failed attempt was reported to the account stream (not final).
    const events = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('task_events')
        .select(['type', 'data'])
        .where('type', '=', 'webhook.delivery_failed')
        .execute(),
    );
    expect(events.map((e) => e.data)).toEqual([
      {
        endpointId: ep.id,
        deliveryId: d!.id,
        eventType: 'task.failed',
        reason: 'HTTP_ERROR',
        attempts: 1,
        final: false,
      },
    ]);
  });

  it('refuses private addresses at delivery time and treats redirects as failures', async () => {
    const user = await newUser(h.db);
    // Endpoints stored before a check, or whose DNS now points inside: never contacted.
    const local = await endpoint(user, 'https://localhost:9/hook', ['task.failed']);
    const literal = await endpoint(user, 'https://10.0.0.7/hook', ['task.failed']);
    const redirect = await endpoint(user, receiver.url('/redirect'), ['task.failed']);
    receiver.respond([302, 302, 302, 302, 302, 302, 302, 302], 302);
    await h.services.tasks.create(user, { request: 'tell me a joke', source: 'text' }, {});
    await drain(h.worker);
    for (const ep of [local, literal]) {
      const [d] = await deliveries(user, ep.id);
      // Final at once: retrying cannot make a private address public.
      expect(d).toMatchObject({
        status: 'failed',
        attempts: 1,
        failure_reason: 'PRIVATE_ADDRESS',
        response_status: null,
      });
      expect((await endpointRow(user, ep.id)).consecutive_failures).toBe(1);
    }
    const [r] = await deliveries(user, redirect.id);
    expect(r).toMatchObject({
      status: 'pending',
      failure_reason: 'REDIRECT',
      response_status: 302,
    });
    expect(receiver.received.filter((x) => x.path === '/redirect')).toHaveLength(1);
  });

  it('disables an endpoint after repeated failed deliveries and notifies the user', async () => {
    const user = await newUser(h.db);
    const ep = await endpoint(user, receiver.url('/down'), ['task.failed']);
    receiver.respond([], 503);
    for (let i = 0; i < WEBHOOK_LIMITS.disableAfterFailedDeliveries; i++)
      await h.services.tasks.create(
        user,
        { request: `tell me joke number ${i}`, source: 'text' },
        {},
      );
    await settle(user, ep.id);
    const rows = await deliveries(user, ep.id);
    expect(rows).toHaveLength(WEBHOOK_LIMITS.disableAfterFailedDeliveries);
    expect(
      rows.every((d) => d.status === 'failed' && d.attempts === WEBHOOK_LIMITS.maxAttempts),
    ).toBe(true);
    expect(receiver.received.filter((x) => x.path === '/down')).toHaveLength(
      WEBHOOK_LIMITS.disableAfterFailedDeliveries * WEBHOOK_LIMITS.maxAttempts,
    );
    expect(await endpointRow(user, ep.id)).toMatchObject({
      status: 'disabled',
      disabled_reason: 'failures',
      consecutive_failures: WEBHOOK_LIMITS.disableAfterFailedDeliveries,
    });
    const notes = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('notifications')
        .select(['kind', 'data'])
        .where('kind', '=', 'webhook_disabled')
        .execute(),
    );
    expect(notes).toEqual([
      { kind: 'webhook_disabled', data: { endpointHost: receiver.hostPort } },
    ]);
    const changed = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('task_events')
        .select('data')
        .where('type', '=', 'webhook.endpoint_changed')
        .execute(),
    );
    expect(changed.map((c) => c.data)).toEqual([
      { endpointId: ep.id, change: 'disabled', status: 'disabled', disabledReason: 'failures' },
    ]);
    // A disabled endpoint gets nothing more.
    await h.services.tasks.create(user, { request: 'tell me one more joke', source: 'text' }, {});
    await drain(h.worker);
    expect(await deliveries(user, ep.id)).toHaveLength(WEBHOOK_LIMITS.disableAfterFailedDeliveries);
  });

  it('a delivery whose endpoint was disabled meanwhile is not sent', async () => {
    const user = await newUser(h.db);
    const ep = await endpoint(user, receiver.url('/later'), ['task.failed']);
    await h.services.tasks.create(user, { request: 'tell me a joke', source: 'text' }, {});
    // Plan only (the task fails, the delivery job is queued), then the user switches the endpoint off.
    expect(await runOnce(h.worker, { limit: 1 })).toBe(1);
    expect(await deliveries(user, ep.id)).toHaveLength(1);
    await withContext(h.db, user, (trx) =>
      trx
        .updateTable('webhook_endpoints')
        .set({ status: 'disabled', disabled_reason: 'user' })
        .where('id', '=', ep.id)
        .execute(),
    );
    await drain(h.worker);
    const [d] = await deliveries(user, ep.id);
    expect(d).toMatchObject({ status: 'failed', failure_reason: 'ENDPOINT_DISABLED', attempts: 0 });
    expect(receiver.received.filter((x) => x.path === '/later')).toHaveLength(0);
  });
});
