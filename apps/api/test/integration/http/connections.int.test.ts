import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Connection } from '@jarvis/contracts';
import { withContext, type DbContext } from '../../../src/db/pool';
import { openSecret } from '../../../src/modules/connections/smtp';
import { testSecrets } from '../helpers';
import { createHarness, newClient, seedConnection, type Client, type Harness } from './support';

const SMTP_USER = 'jarvis';
const SMTP_PASSWORD = 'correct-horse-battery-staple';

let h: Harness;
let strict: Harness; // SMTP_ALLOW_INSECURE_LOCALHOST=false
let smtp: SMTPServer;
let smtpPort: number;
let smtpPasswordOk = true;

beforeAll(async () => {
  h = await createHarness();
  strict = await createHarness({ env: { SMTP_ALLOW_INSECURE_LOCALHOST: 'false' } });
  smtp = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authMethods: ['PLAIN', 'LOGIN'],
    logger: false,
    onAuth(auth, _session, cb) {
      if (smtpPasswordOk && auth.username === SMTP_USER && auth.password === SMTP_PASSWORD)
        return cb(null, { user: SMTP_USER });
      return cb(new Error('Invalid username or password'));
    },
    onData(stream, _session, cb) {
      stream.resume();
      stream.on('end', () => cb());
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  smtpPort = (smtp.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => smtp.close(() => resolve()));
  await h.close();
  await strict.close();
});

const smtpBody = (overrides: Record<string, unknown> = {}) => ({
  label: 'Work mail',
  host: '127.0.0.1',
  port: smtpPort,
  security: 'none',
  username: SMTP_USER,
  password: SMTP_PASSWORD,
  fromAddress: 'me@example.com',
  fromName: 'Me',
  ...overrides,
});

async function rawRows(ctx: DbContext) {
  return withContext(h.db, ctx, (trx) =>
    trx.selectFrom('connections').selectAll().orderBy('created_at').execute(),
  );
}

async function list(c: Client) {
  const res = await c.request('GET', '/v1/connections');
  expect(res.statusCode).toBe(200);
  return res.json<{ items: Connection[] }>().items;
}

describe('POST /v1/connections/smtp', () => {
  it('verifies against the server, then stores the password only encrypted', async () => {
    const c = await newClient(h);
    const res = await c.request('POST', '/v1/connections/smtp', smtpBody());
    expect(res.statusCode).toBe(201);
    const conn = res.json<Connection>();
    expect(conn).toMatchObject({
      provider: 'smtp',
      label: 'Work mail',
      accountIdentifier: 'me@example.com',
      status: 'active',
      permissions: ['email.send'],
      lastError: null,
    });
    expect(conn.lastVerifiedAt).not.toBeNull();
    expect(res.body).not.toContain(SMTP_PASSWORD);

    const [row] = await rawRows(c.user);
    expect(row!.config).toEqual({
      host: '127.0.0.1',
      port: smtpPort,
      security: 'none',
      username: SMTP_USER,
      fromAddress: 'me@example.com',
      fromName: 'Me',
    });
    expect(JSON.stringify(row!.config)).not.toContain(SMTP_PASSWORD);
    expect(row!.secret_ciphertext).toBeInstanceOf(Buffer);
    expect(row!.secret_ciphertext!.toString('utf8')).not.toContain(SMTP_PASSWORD);
    expect(openSecret(testSecrets(h.config), row!)).toEqual({ password: SMTP_PASSWORD });

    // Listing never exposes secrets or provider settings.
    const items = await list(c);
    expect(items.map((i) => i.id)).toEqual([conn.id]);
    expect(JSON.stringify(items)).not.toMatch(/password|127\.0\.0\.1|ciphertext/i);
  });

  it('replaces the existing mailbox instead of adding a second one', async () => {
    const c = await newClient(h);
    const first = (await c.request('POST', '/v1/connections/smtp', smtpBody())).json<Connection>();
    const second = await c.request(
      'POST',
      '/v1/connections/smtp',
      smtpBody({ label: 'Renamed', fromAddress: 'other@example.com' }),
    );
    expect(second.statusCode).toBe(201);
    expect(second.json<Connection>()).toMatchObject({
      id: first.id,
      label: 'Renamed',
      accountIdentifier: 'other@example.com',
    });
    expect(await list(c)).toHaveLength(1);
  });

  it('rejects a wrong password with CONNECTION_FAILED and saves nothing', async () => {
    const c = await newClient(h);
    const res = await c.request(
      'POST',
      '/v1/connections/smtp',
      smtpBody({ password: 'wrong-password' }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: 'CONNECTION_FAILED',
      message: 'The mail server rejected the username or password.',
    });
    expect(await rawRows(c.user)).toEqual([]);
  });

  it('refuses unencrypted SMTP when SMTP_ALLOW_INSECURE_LOCALHOST is false', async () => {
    const c = await newClient(strict);
    // Standard port, so the encryption rule (not the port rule) is what refuses it.
    const res = await c.request('POST', '/v1/connections/smtp', smtpBody({ port: 2525 }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('CONNECTION_FAILED');
    expect(res.json().error.message).toMatch(/Unencrypted SMTP is not allowed/);
    expect(await rawRows(c.user)).toEqual([]);
  });

  it('refuses private network destinations (SSRF)', async () => {
    const c = await newClient(strict);
    const res = await c.request(
      'POST',
      '/v1/connections/smtp',
      smtpBody({ host: '10.1.2.3', port: 465, security: 'tls' }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('CONNECTION_FAILED');
    expect(res.json().error.message).toMatch(/private or reserved address/);
    expect(await rawRows(c.user)).toEqual([]);
  });

  it('refuses non-standard ports so checks cannot probe other services', async () => {
    const c = await newClient(strict);
    const res = await c.request(
      'POST',
      '/v1/connections/smtp',
      smtpBody({ host: 'smtp.example.com', port: 8080, security: 'tls' }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: 'CONNECTION_FAILED',
      message: 'Use a standard mail server port: 465 (TLS), 587 (STARTTLS), 25 or 2525.',
    });
    expect(await rawRows(c.user)).toEqual([]);
  });

  it('validates the request body', async () => {
    const c = await newClient(h);
    const res = await c.request('POST', '/v1/connections/smtp', smtpBody({ fromAddress: 'nope' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /v1/connections/web', () => {
  it('accepts a body-less POST that still declares a JSON content type', async () => {
    const c = await newClient(h);
    const res = await c.request('POST', '/v1/connections/web', undefined, {
      'content-type': 'application/json',
      'content-length': '0',
    });
    expect(res.statusCode).toBe(201);
  });

  it('creates the web connection, then reactivates it instead of duplicating', async () => {
    const c = await newClient(h);
    const res = await c.request('POST', '/v1/connections/web');
    expect(res.statusCode).toBe(201);
    const web = res.json<Connection>();
    expect(web).toMatchObject({
      provider: 'web',
      label: 'Web access',
      status: 'active',
      permissions: ['web.fetch'],
      accountIdentifier: null,
    });
    await withContext(h.db, c.user, (trx) =>
      trx.updateTable('connections').set({ status: 'error' }).where('id', '=', web.id).execute(),
    );
    const again = await c.request('POST', '/v1/connections/web');
    expect(again.json<Connection>()).toMatchObject({ id: web.id, status: 'active' });
    expect(await list(c)).toHaveLength(1);
  });

  it('creates a fresh row after a revoke', async () => {
    const c = await newClient(h);
    const first = (await c.request('POST', '/v1/connections/web')).json<Connection>();
    expect((await c.request('DELETE', `/v1/connections/${first.id}`)).statusCode).toBe(204);
    const second = (await c.request('POST', '/v1/connections/web')).json<Connection>();
    expect(second.id).not.toBe(first.id);
    expect((await list(c)).map((i) => i.id)).toEqual([second.id]);
  });
});

describe('POST /v1/connections/:id/test', () => {
  it('re-verifies SMTP and records failures and recoveries', async () => {
    const c = await newClient(h);
    const conn = (await c.request('POST', '/v1/connections/smtp', smtpBody())).json<Connection>();

    smtpPasswordOk = false;
    try {
      const failed = await c.request('POST', `/v1/connections/${conn.id}/test`);
      expect(failed.statusCode).toBe(200);
      expect(failed.json<Connection>()).toMatchObject({
        status: 'error',
        lastError: 'The mail server rejected the username or password.',
        lastVerifiedAt: conn.lastVerifiedAt,
      });
    } finally {
      smtpPasswordOk = true;
    }
    const ok = await c.request('POST', `/v1/connections/${conn.id}/test`);
    expect(ok.json<Connection>()).toMatchObject({ status: 'active', lastError: null });
    expect(new Date(ok.json<Connection>().lastVerifiedAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(conn.lastVerifiedAt!).getTime(),
    );
    // Status changes are announced on the event stream.
    const events = await withContext(h.db, c.user, (trx) =>
      trx
        .selectFrom('task_events')
        .select(['type', 'data'])
        .where('type', '=', 'connection.changed')
        .orderBy('id')
        .execute(),
    );
    expect(events.map((e) => (e.data as { status: string }).status)).toEqual([
      'active',
      'error',
      'active',
    ]);
  });

  it('marks web access active', async () => {
    const c = await newClient(h);
    const id = await seedConnection(h.db, c.user, 'web', 'error');
    const res = await c.request('POST', `/v1/connections/${id}/test`);
    expect(res.json<Connection>()).toMatchObject({ id, status: 'active', lastError: null });
  });
});

describe('DELETE /v1/connections/:id', () => {
  it('revokes and erases the stored credentials and settings', async () => {
    const c = await newClient(h);
    const conn = (await c.request('POST', '/v1/connections/smtp', smtpBody())).json<Connection>();
    const res = await c.request('DELETE', `/v1/connections/${conn.id}`);
    expect(res.statusCode).toBe(204);
    expect(await list(c)).toEqual([]);
    const [row] = await rawRows(c.user);
    expect(row).toMatchObject({
      status: 'revoked',
      secret_ciphertext: null,
      secret_key_id: null,
      config: {},
    });
    expect((await c.request('DELETE', `/v1/connections/${conn.id}`)).statusCode).toBe(404);
    expect((await c.request('POST', `/v1/connections/${conn.id}/test`)).statusCode).toBe(404);
  });
});

describe('cross-tenant isolation', () => {
  it('another tenant cannot list, test or delete a connection', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    const id = await seedConnection(h.db, alice.user, 'smtp');
    expect(await list(bob)).toEqual([]);
    expect((await bob.request('POST', `/v1/connections/${id}/test`)).statusCode).toBe(404);
    expect((await bob.request('DELETE', `/v1/connections/${id}`)).statusCode).toBe(404);
    expect((await list(alice)).map((i) => i.status)).toEqual(['active']);
  });
});
