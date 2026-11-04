/**
 * Phase C HTTP test support: the real Fastify app (support.ts harness) wired
 * to the mock Google and Microsoft providers (tools/mock-providers — test
 * doubles, never used by src/), plus seeding of the browser agent's records
 * (sessions, evidence files, orders, bookings, email watches) through RLS as
 * their owner. OAuth connections are made through the real HTTP flow: start
 * → the mock's consent redirect → callback, so every test with a connection
 * also exercised state, PKCE and the exchange.
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  ConnectionCapability,
  OAuthCallbackResult,
  OAuthProvider,
  OAuthStartResponse,
} from '@jarvis/contracts';
import {
  startGoogleMock,
  startMicrosoftMock,
  type MockProvider,
} from '../../../../../tools/mock-providers/index.mjs';
import { withContext, type DbContext } from '../../../src/db/pool';
import type { SecretBox } from '../../../src/lib/crypto';
import { clearUpcomingCache } from '../../../src/modules/integrations/upcoming';
import type { ObjectStorage } from '../../../src/modules/storage/types';
import { testSecrets } from '../helpers';
import { createHarness, type Client, type Harness } from './support';

export const CLIENT_ID = 'jarvis-http-test-client';
export const CLIENT_SECRET = 'jarvis-http-test-secret';
export const REDIRECT_URI = 'http://localhost:3000/connections/callback';

export interface OAuthHarness extends Harness {
  google: MockProvider;
  microsoft: MockProvider;
  secrets: SecretBox;
}

export async function createOAuthHarness(
  opts: { env?: Record<string, string>; storage?: ObjectStorage | null } = {},
): Promise<OAuthHarness> {
  const mockOpts = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, accounts: [] };
  const google = await startGoogleMock(mockOpts);
  const microsoft = await startMicrosoftMock(mockOpts);
  const h = await createHarness({
    env: {
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      GOOGLE_BASE_URL_OVERRIDE: google.url,
      MICROSOFT_CLIENT_ID: CLIENT_ID,
      MICROSOFT_CLIENT_SECRET: CLIENT_SECRET,
      MICROSOFT_BASE_URL_OVERRIDE: microsoft.url,
      OAUTH_REDIRECT_URIS: REDIRECT_URI,
      ...opts.env,
    },
    ...(opts.storage === undefined ? {} : { storage: opts.storage }),
  });
  clearUpcomingCache();
  return {
    ...h,
    google,
    microsoft,
    secrets: testSecrets(h.config),
    async close() {
      await h.close();
      await google.close();
      await microsoft.close();
    },
  };
}

export const mockOf = (h: OAuthHarness, p: OAuthProvider) =>
  p === 'google' ? h.google : h.microsoft;

/** A mailbox at both mocks for this client's user (unique per user). */
export function addMailbox(h: OAuthHarness, c: Client, tag = 'owner'): string {
  const mailbox = `${tag}-${c.user.userId.slice(0, 8)}@mail.test`;
  for (const m of [h.google, h.microsoft]) m.addAccount({ email: mailbox, name: 'Test Owner' });
  return mailbox;
}

/** Follows the authorization URL at the mock (auto-consent) and returns the redirect's parameters. */
export async function consent(authorizationUrl: string): Promise<URLSearchParams> {
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  if (res.status !== 302) throw new Error(`consent: ${res.status} ${await res.text()}`);
  return new URL(res.headers.get('location')!).searchParams;
}

/** The provider's redirect as the client page forwards it to the callback route. */
export const callbackBody = (p: URLSearchParams) => ({
  state: p.get('state')!,
  ...(p.get('code') ? { code: p.get('code')! } : {}),
  ...(p.get('error') ? { error: p.get('error')! } : {}),
  ...(p.get('iss') ? { iss: p.get('iss')! } : {}),
});

export async function startOAuth(
  c: Client,
  provider: OAuthProvider,
  capabilities: ConnectionCapability[],
  extra: { connectionId?: string; returnTo?: string; redirectUri?: string } = {},
): Promise<OAuthStartResponse> {
  const res = await c.request('POST', '/v1/connections/oauth/start', {
    provider,
    capabilities,
    redirectUri: extra.redirectUri ?? REDIRECT_URI,
    ...(extra.connectionId ? { connectionId: extra.connectionId } : {}),
    ...(extra.returnTo ? { returnTo: extra.returnTo } : {}),
  });
  if (res.statusCode !== 200) throw new Error(`start: ${res.statusCode} ${res.body}`);
  return res.json<OAuthStartResponse>();
}

/** The whole flow over HTTP for `mailbox` (start → consent → callback). */
export async function connectOAuth(
  h: OAuthHarness,
  c: Client,
  provider: OAuthProvider,
  capabilities: ConnectionCapability[],
  opts: { mailbox: string; connectionId?: string; returnTo?: string },
): Promise<OAuthCallbackResult> {
  mockOf(h, provider).setLoginAccount(opts.mailbox);
  const start = await startOAuth(c, provider, capabilities, opts);
  const params = await consent(start.authorizationUrl);
  const res = await c.request('POST', '/v1/connections/oauth/callback', callbackBody(params));
  if (res.statusCode !== 200) throw new Error(`callback: ${res.statusCode} ${res.body}`);
  return res.json<OAuthCallbackResult>();
}

/* ------------------------------------------------------------------ */
/* Browser agent records (as the commerce / browser modules write them) */
/* ------------------------------------------------------------------ */

export interface SeededTask {
  taskId: string;
  stepId: string;
}

export async function seedStepTask(
  h: Harness,
  ctx: DbContext,
  toolId = 'shop.checkout',
): Promise<SeededTask> {
  return withContext(h.db, ctx, async (trx) => {
    const conv = await trx
      .insertInto('conversations')
      .values({ tenant_id: ctx.tenantId, user_id: ctx.userId, title: 'Phase C' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const task = await trx
      .insertInto('tasks')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        conversation_id: conv.id,
        title: 'Buy headphones',
        request: 'buy the FX-100 headphones on the fixture shop',
        source: 'text',
        status: 'COMPLETED',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const step = await trx
      .insertInto('task_steps')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: task.id,
        position: 0,
        step_key: 's1',
        title: 'Place the order',
        tool_id: toolId,
        input: JSON.stringify({}),
        risk_level: 'HIGH',
        status: 'SUCCEEDED',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { taskId: task.id, stepId: step.id };
  });
}

export async function seedBrowserSession(
  h: Harness,
  ctx: DbContext,
  t: SeededTask,
  opts: {
    status?: 'succeeded' | 'handover' | 'failed';
    siteId?: string;
    operation?: string;
    createdAt?: Date;
  } = {},
): Promise<string> {
  const status = opts.status ?? 'succeeded';
  return withContext(h.db, ctx, async (trx) => {
    const row = await trx
      .insertInto('browser_sessions')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: t.taskId,
        step_id: t.stepId,
        status,
        site_id: opts.siteId ?? 'fixture-shop',
        operation: opts.operation ?? 'checkout',
        idempotency_key: `exec:${randomUUID()}`,
        request: JSON.stringify({ cartId: 'cart-1' }),
        result: status === 'succeeded' ? JSON.stringify({ orderId: 'FX-1' }) : null,
        stop_reason: status === 'succeeded' ? null : 'CAPTCHA_DETECTED',
        handover_url: status === 'handover' ? 'http://127.0.0.1:4599/captcha' : null,
        navigations: 3,
        requests: 41,
        blocked_requests: 2,
        started_at: new Date(),
        ended_at: new Date(),
        ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

const KIND_MEDIA = {
  screenshot: 'image/png',
  extract: 'application/json',
  ics: 'text/calendar',
} as const;

/** An evidence file stored in `h.storage` (when set) and recorded as its owner. */
export async function seedEvidence(
  h: Harness,
  ctx: DbContext,
  t: SeededTask,
  sessionId: string,
  kind: keyof typeof KIND_MEDIA,
  body: Buffer,
  opts: { driver?: 'local' | 's3'; store?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const key = `tenants/${ctx.tenantId}/users/${ctx.userId}/evidence/${id}`;
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (opts.store !== false && h.storage)
    await h.storage.put(key, { body, contentType: KIND_MEDIA[kind], sha256 });
  await withContext(h.db, ctx, (trx) =>
    trx
      .insertInto('evidence_artifacts')
      .values({
        id,
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: t.taskId,
        browser_session_id: sessionId,
        kind,
        media_type: KIND_MEDIA[kind],
        size_bytes: body.length,
        sha256,
        storage_driver: opts.driver ?? 'local',
        storage_key: key,
        page_url: 'http://127.0.0.1:4599/shop/checkout',
      })
      .execute(),
  );
  return id;
}

export async function seedOrder(
  h: Harness,
  ctx: DbContext,
  opts: {
    task?: SeededTask | null;
    status?: 'submitting' | 'placed' | 'failed' | 'unknown';
    createdAt?: Date;
    cartArtifactId?: string | null;
    confirmationArtifactId?: string | null;
    totalMicro?: number;
  } = {},
): Promise<string> {
  const status = opts.status ?? 'placed';
  return withContext(h.db, ctx, async (trx) => {
    const row = await trx
      .insertInto('orders')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: opts.task?.taskId ?? null,
        step_id: opts.task?.stepId ?? null,
        site_id: 'fixture-shop',
        merchant_name: 'Fixture Audio',
        merchant_host: '127.0.0.1:4599',
        idempotency_key: `order:${randomUUID()}`,
        status,
        items: JSON.stringify([
          {
            title: 'FX-100 headphones',
            quantity: 1,
            unitPrice: { amountMicro: 79_000_000, currency: 'USD' },
            lineTotal: { amountMicro: 79_000_000, currency: 'USD' },
            productUrl: 'http://127.0.0.1:4599/shop/products/fx-100',
          },
        ]),
        currency: 'USD',
        subtotal_micro: 79_000_000,
        shipping_micro: 4_990_000,
        tax_micro: null,
        total_micro: opts.totalMicro ?? 83_990_000,
        merchant_order_id: status === 'placed' ? `FX-${randomUUID().slice(0, 6)}` : null,
        placed_at: status === 'placed' ? new Date() : null,
        failure_reason:
          status === 'failed' ? 'PRICE_CHANGED' : status === 'unknown' ? 'ORDER_UNKNOWN' : null,
        action_hash: 'h'.repeat(64),
        cart_artifact_id: opts.cartArtifactId ?? null,
        confirmation_artifact_id: opts.confirmationArtifactId ?? null,
        ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

export async function seedBooking(
  h: Harness,
  ctx: DbContext,
  opts: {
    task?: SeededTask | null;
    status?: 'submitting' | 'confirmed' | 'failed' | 'unknown' | 'cancelled';
    createdAt?: Date;
    icsArtifactId?: string | null;
    confirmationArtifactId?: string | null;
    priceMicro?: number | null;
  } = {},
): Promise<string> {
  const status = opts.status ?? 'confirmed';
  return withContext(h.db, ctx, async (trx) => {
    const row = await trx
      .insertInto('bookings')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: opts.task?.taskId ?? null,
        step_id: opts.task?.stepId ?? null,
        site_id: 'fixture-booking',
        site_name: 'Fixture Dental',
        site_host: '127.0.0.1:4599',
        service: 'Check-up',
        idempotency_key: `booking:${randomUUID()}`,
        status,
        slot_start: new Date('2026-11-10T09:00:00Z'),
        slot_end: new Date('2026-11-10T09:30:00Z'),
        time_zone: 'Europe/Berlin',
        reference: status === 'confirmed' ? 'FXD-42' : null,
        price_micro: opts.priceMicro ?? null,
        price_currency: opts.priceMicro == null ? null : 'USD',
        binding: opts.priceMicro != null,
        failure_reason:
          status === 'failed' ? 'SLOT_TAKEN' : status === 'unknown' ? 'BOOKING_UNCONFIRMED' : null,
        action_hash: 'h'.repeat(64),
        confirmation_artifact_id: opts.confirmationArtifactId ?? null,
        ics_artifact_id: opts.icsArtifactId ?? null,
        ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

/** One live email watch on `connectionId` (the integrations module writes these). */
export async function seedWatch(
  h: Harness,
  ctx: DbContext,
  connectionId: string,
  opts: { provider?: OAuthProvider; createdAt?: Date; subject?: string } = {},
): Promise<string> {
  return withContext(h.db, ctx, async (trx) => {
    const row = await trx
      .insertInto('email_watches')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        connection_id: connectionId,
        provider: opts.provider ?? 'google',
        thread_id: `thread-${randomUUID().slice(0, 8)}`,
        subject: opts.subject ?? 'Quote for the kitchen',
        next_check_at: new Date(Date.now() + 600_000),
        expires_at: new Date(Date.now() + 14 * 86_400_000),
        ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
}
