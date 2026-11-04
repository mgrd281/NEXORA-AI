/**
 * Integration harness of the integrations domain: real Postgres (RLS), the
 * mock Google and Microsoft providers (tools/mock-providers), the real
 * AgentServices and the worker's runOnce. OAuth connections are made through
 * the real flow (start → the mock's consent redirect → callback), so every
 * test that has a connection also exercised PKCE, state and the exchange.
 */
import { randomUUID } from 'node:crypto';
import type { ConnectionCapability, OAuthCallbackResult, OAuthProvider } from '@jarvis/contracts';
import {
  startGoogleMock,
  startMicrosoftMock,
  type MockProvider,
} from '../../../../../tools/mock-providers/index.mjs';
import type { Config } from '../../../src/config';
import { withContext, type Db, type DbContext } from '../../../src/db/pool';
import type { RequestContext } from '../../../src/http/context';
import type { SecretBox } from '../../../src/lib/crypto';
import { createAgentServices } from '../../../src/modules/agent/index';
import type { ModelAdapter } from '../../../src/modules/agent/models/adapter';
import { silentLogger, type RuntimeDeps } from '../../../src/modules/agent/runtime';
import { createSession } from '../../../src/modules/auth/sessions';
import { integrations } from '../../../src/modules/integrations';
import { clearUpcomingCache } from '../../../src/modules/integrations/upcoming';
import type { AgentServices } from '../../../src/services';
import type { WorkerDeps } from '../../../src/worker';
import { createTestUser, testConfig, testDb, testSecrets, type TestUser } from '../helpers';

export const CLIENT_ID = 'jarvis-test-client';
export const CLIENT_SECRET = 'jarvis-test-secret';
export const REDIRECT_URI = 'http://localhost:3000/connections/callback';

export interface IntegrationsHarness {
  google: MockProvider;
  microsoft: MockProvider;
  config: Config;
  db: Db;
  secrets: SecretBox;
  services: AgentServices;
  worker: WorkerDeps;
  close(): Promise<void>;
}

export async function createIntegrationsHarness(
  opts: {
    env?: Record<string, string>;
    adapter?: ModelAdapter;
    testHooks?: RuntimeDeps['testHooks'];
    accessTokenTtlSeconds?: number;
  } = {},
): Promise<IntegrationsHarness> {
  const mockOpts = {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accounts: [],
    accessTokenTtlSeconds: opts.accessTokenTtlSeconds ?? 3599,
  };
  const google = await startGoogleMock(mockOpts);
  const microsoft = await startMicrosoftMock(mockOpts);
  const config = testConfig({
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_BASE_URL_OVERRIDE: google.url,
    MICROSOFT_CLIENT_ID: CLIENT_ID,
    MICROSOFT_CLIENT_SECRET: CLIENT_SECRET,
    MICROSOFT_BASE_URL_OVERRIDE: microsoft.url,
    OAUTH_REDIRECT_URIS: REDIRECT_URI,
    STORAGE_DRIVER: 'none',
    ...opts.env,
  });
  const db = testDb();
  const secrets = testSecrets(config);
  const services = createAgentServices({ config, db, secrets, storage: null });
  const worker: WorkerDeps = {
    config,
    db,
    secrets,
    adapter: opts.adapter ?? null,
    storage: null,
    log: silentLogger,
    workerId: `test-${randomUUID().slice(0, 8)}`,
    testHooks: opts.testHooks,
  };
  clearUpcomingCache();
  return {
    google,
    microsoft,
    config,
    db,
    secrets,
    services,
    worker,
    async close() {
      await google.close();
      await microsoft.close();
      await db.destroy();
    },
  };
}

/** A signed-in session of the user (the OAuth state is bound to it). */
export async function sessionOf(db: Db, user: DbContext): Promise<RequestContext> {
  const s = await withContext(db, user, (trx) =>
    createSession(trx, {
      tenantId: user.tenantId,
      userId: user.userId,
      platform: 'web',
      ttlDays: 1,
    }),
  );
  return {
    ...user,
    sessionId: s.id,
    platform: 'web',
    via: 'cookie',
    requestId: randomUUID(),
    ip: '127.0.0.1',
    userAgent: 'vitest',
  };
}

/** Follows the authorization URL at the mock (auto-consent) and returns the redirect's parameters. */
export async function consent(authorizationUrl: string): Promise<URLSearchParams> {
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  if (res.status !== 302) throw new Error(`consent: ${res.status} ${await res.text()}`);
  return new URL(res.headers.get('location')!).searchParams;
}

export const callbackBody = (p: URLSearchParams) => ({
  state: p.get('state')!,
  ...(p.get('code') ? { code: p.get('code')! } : {}),
  ...(p.get('error') ? { error: p.get('error')! } : {}),
  ...(p.get('iss') ? { iss: p.get('iss')! } : {}),
});

/** A user with a unique mailbox at the provider mock(s). */
export async function newUserWithMailbox(
  h: IntegrationsHarness,
  opts: { timeZone?: string } = {},
): Promise<TestUser & { mailbox: string }> {
  const user = await createTestUser(h.db);
  const mailbox = `${user.userId.slice(0, 8)}@mail.test`;
  for (const m of [h.google, h.microsoft])
    m.addAccount({ email: mailbox, name: 'Test Owner', timeZone: opts.timeZone ?? 'UTC' });
  if (opts.timeZone)
    await withContext(h.db, user, (trx) =>
      trx
        .updateTable('users')
        .set({ time_zone: opts.timeZone! })
        .where('id', '=', user.userId)
        .execute(),
    );
  return { ...user, mailbox };
}

/** The whole OAuth flow (start → consent → callback) for this user's mailbox. */
export async function connect(
  h: IntegrationsHarness,
  user: TestUser & { mailbox: string },
  provider: OAuthProvider,
  capabilities: ConnectionCapability[],
  opts: { connectionId?: string; returnTo?: string; session?: RequestContext } = {},
): Promise<OAuthCallbackResult> {
  const mock = provider === 'google' ? h.google : h.microsoft;
  mock.setLoginAccount(user.mailbox);
  const ctx = opts.session ?? (await sessionOf(h.db, user));
  const start = await integrations.startOAuth(h, ctx, {
    provider,
    capabilities,
    redirectUri: REDIRECT_URI,
    ...(opts.connectionId ? { connectionId: opts.connectionId } : {}),
    ...(opts.returnTo ? { returnTo: opts.returnTo } : {}),
  });
  const params = await consent(start.authorizationUrl);
  return integrations.completeOAuth(h, ctx, callbackBody(params));
}

export const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
export const HOUR = 3_600_000;
