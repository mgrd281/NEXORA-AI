import type { AddressInfo } from 'node:net';
import { sql } from 'kysely';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, type Me } from '@jarvis/contracts';
import { withContext } from '../../../src/db/pool';
import { createTestUser, TEST_PASSWORD } from '../helpers';
import {
  createHarness,
  loginWeb,
  newClient,
  seedApproval,
  seedNotification,
  seedTask,
  WEB_ORIGIN,
  type Harness,
} from './support';

const SMTP_PASSWORD = 'export-must-never-contain-this-password';

let h: Harness;
let smtp: SMTPServer;
let smtpPort: number;

beforeAll(async () => {
  h = await createHarness();
  smtp = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, _s, cb) {
      return auth.password === SMTP_PASSWORD
        ? cb(null, { user: auth.username })
        : cb(new Error('Invalid username or password'));
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  smtpPort = (smtp.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => smtp.close(() => resolve()));
  await h.close();
});

describe('GET/PATCH /v1/me', () => {
  it('returns the profile with resolved preferences', async () => {
    const c = await newClient(h);
    const res = await c.request('GET', '/v1/me');
    expect(res.statusCode).toBe(200);
    expect(res.json<Me>()).toMatchObject({
      id: c.user.userId,
      email: c.user.email,
      roles: ['owner'],
      tenant: { id: c.user.tenantId },
      preferences: DEFAULT_PREFERENCES,
    });
  });

  it('updates profile fields and deep-merges partial preferences', async () => {
    const c = await newClient(h);
    const res = await c.request('PATCH', '/v1/me', {
      displayName: '  Ada  ',
      locale: 'ar',
      timeZone: 'Europe/Berlin',
      theme: 'dark',
      preferences: { voice: { speakResponses: true }, spending: { monthlyAiBudgetUsd: 5 } },
    });
    expect(res.statusCode).toBe(200);
    const me = res.json<Me>();
    expect(me).toMatchObject({
      displayName: 'Ada',
      locale: 'ar',
      timeZone: 'Europe/Berlin',
      theme: 'dark',
    });
    expect(me.preferences).toEqual({
      ...DEFAULT_PREFERENCES,
      voice: { ...DEFAULT_PREFERENCES.voice, speakResponses: true },
      // Phase C: the purchase limit keeps its value (0) when only the AI budget changes.
      spending: { ...DEFAULT_PREFERENCES.spending, monthlyAiBudgetUsd: 5 },
    });
    // A second partial update keeps earlier changes.
    const next = await c.request('PATCH', '/v1/me', {
      preferences: { voice: { recognitionLocale: 'ar-SA' }, memory: { enabled: false } },
    });
    expect(next.json<Me>().preferences).toMatchObject({
      voice: { speakResponses: true, recognitionLocale: 'ar-SA' },
      spending: { monthlyAiBudgetUsd: 5 },
      memory: { enabled: false },
    });
    expect((await c.request('GET', '/v1/me')).json<Me>().preferences.memory.enabled).toBe(false);
  });

  it('accepts UTC and rejects unknown time zones and invalid values', async () => {
    const c = await newClient(h);
    expect((await c.request('PATCH', '/v1/me', { timeZone: 'UTC' })).statusCode).toBe(200);
    const bad = await c.request('PATCH', '/v1/me', { timeZone: 'Mars/Olympus_Mons' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_FAILED');
    expect(
      (await c.request('PATCH', '/v1/me', { timeZone: "'; drop table users; --" })).statusCode,
    ).toBe(400);
    expect((await c.request('PATCH', '/v1/me', { locale: 'fr' })).statusCode).toBe(400);
    expect(
      (
        await c.request('PATCH', '/v1/me', {
          preferences: { spending: { monthlyAiBudgetUsd: -1 } },
        })
      ).statusCode,
    ).toBe(400);
    expect((await c.request('GET', '/v1/me')).json<Me>().timeZone).toBe('UTC');
  });
});

describe('POST /v1/account/export', () => {
  it('exports all personal data as an attachment without any secret', async () => {
    const c = await newClient(h);
    const conn = await c.request('POST', '/v1/connections/smtp', {
      host: '127.0.0.1',
      port: smtpPort,
      security: 'none',
      username: 'me',
      password: SMTP_PASSWORD,
      fromAddress: 'me@example.com',
    });
    expect(conn.statusCode).toBe(201);
    const created = await c.request('POST', '/v1/tasks', { request: 'Export me please' });
    const taskId = created.json<{ id: string }>().id;
    await seedApproval(h.db, c.user, taskId);
    await c.request('POST', '/v1/memories', { content: 'Favourite tea: Earl Grey' });
    await seedNotification(h.db, c.user, { taskId });
    await c.request('POST', '/v1/voice-sessions', { locale: 'en-US', engine: 'ios_speech' });
    await withContext(h.db, c.user, (trx) =>
      trx
        .insertInto('cost_records')
        .values({
          tenant_id: c.user.tenantId,
          user_id: c.user.userId,
          task_id: taskId,
          category: 'model',
          amount_micro: 4321,
        })
        .execute(),
    );

    const res = await c.request('POST', '/v1/account/export');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="jarvis-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const doc = res.json<Record<string, unknown>>();
    expect(doc).toMatchObject({
      format: 'jarvis.account-export',
      version: 4,
      profile: { id: c.user.userId, email: c.user.email },
      preferences: DEFAULT_PREFERENCES,
    });
    expect(typeof doc.exportedAt).toBe('string');
    const tasks = doc.tasks as {
      id: string;
      request: string;
      steps: unknown[];
      approvals: unknown[];
      events: unknown[];
    }[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: taskId, request: 'Export me please' });
    expect(tasks[0]!.steps).toHaveLength(1);
    expect(tasks[0]!.approvals).toHaveLength(1);
    expect(tasks[0]!.events.length).toBeGreaterThan(0);
    expect(doc.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'Export me please', taskId }),
    ]);
    expect(doc.memories).toEqual([
      expect.objectContaining({ content: 'Favourite tea: Earl Grey' }),
    ]);
    expect(doc.connections).toEqual([
      expect.objectContaining({ provider: 'smtp', accountIdentifier: 'me@example.com' }),
    ]);
    expect(doc.notifications).toHaveLength(1);
    expect(doc.voiceSessions).toHaveLength(1);
    expect((doc.sessions as unknown[]).length).toBeGreaterThan(0);
    expect(doc.usage).toMatchObject({ costs: [expect.objectContaining({ amountMicroUsd: 4321 })] });
    // Account-level events (connection changes) are included too.
    expect(doc.events).toEqual([expect.objectContaining({ type: 'connection.changed' })]);

    // No secrets: SMTP password, its ciphertext, the session token, or any credential hash.
    const row = await withContext(h.db, c.user, (trx) =>
      trx.selectFrom('connections').select('secret_ciphertext').executeTakeFirstOrThrow(),
    );
    const ct = row.secret_ciphertext!;
    for (const needle of [
      SMTP_PASSWORD,
      ct.toString('base64'),
      ct.toString('hex'),
      ct.toString('base64url'),
      c.token,
      TEST_PASSWORD,
    ])
      expect(res.body).not.toContain(needle);
    expect(res.body).not.toMatch(/password|token_hash|ciphertext|secret_key|argon2/i);
  });

  it('exports stored step inputs and outputs and tool executions in full', async () => {
    const c = await newClient(h);
    const conn = await c.request('POST', '/v1/connections/smtp', {
      host: '127.0.0.1',
      port: smtpPort,
      security: 'none',
      username: 'me',
      password: SMTP_PASSWORD,
      fromAddress: 'me@example.com',
    });
    expect(conn.statusCode).toBe(201);
    const taskId = await seedTask(h.db, c.user, { status: 'COMPLETED' });
    // A body far longer than any preview, as an auto-approved email to oneself.
    const body = `${'Personal page text. '.repeat(500)}TAIL-MARKER-PERSONAL-DATA`;
    const input = { to: ['me@example.com'], subject: 'Notes', body: '{{s1.text}}' };
    const resolved = { ...input, body };
    const output = {
      messageId: '<m1@example.com>',
      accepted: ['me@example.com'],
      rejected: [],
      response: '250 2.0.0 OK queued as FULL-SMTP-RESPONSE',
      from: 'me@example.com',
      to: ['me@example.com'],
      subject: 'Notes',
    };
    const evidence = [
      {
        kind: 'smtp_receipt',
        label: 'SMTP 250',
        value: 'EVIDENCE-VALUE',
        at: new Date().toISOString(),
      },
    ];
    const stepId = await withContext(h.db, c.user, async (trx) => {
      const step = await trx
        .insertInto('task_steps')
        .values({
          tenant_id: c.user.tenantId,
          user_id: c.user.userId,
          task_id: taskId,
          position: 0,
          step_key: 's2',
          title: 'Email me the notes',
          tool_id: 'email.send',
          input: JSON.stringify(input),
          resolved_input: JSON.stringify(resolved),
          input_preview: JSON.stringify({ ...resolved, body: body.slice(0, 2000) }),
          output: JSON.stringify(output),
          output_preview: JSON.stringify({ messageId: output.messageId }),
          evidence: JSON.stringify(evidence),
          risk_level: 'MEDIUM',
          status: 'SUCCEEDED',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('tool_executions')
        .values({
          tenant_id: c.user.tenantId,
          user_id: c.user.userId,
          task_id: taskId,
          step_id: step.id,
          tool_id: 'email.send',
          tool_version: '1',
          idempotency_key: `exec-${step.id}`,
          status: 'succeeded',
          input_hash: 'input-hash',
          output: JSON.stringify(output),
          evidence: JSON.stringify(evidence),
          cost_micro: 12,
          finished_at: new Date(),
          duration_ms: 345,
        })
        .execute();
      return step.id;
    });

    const res = await c.request('POST', '/v1/account/export');
    expect(res.statusCode).toBe(200);
    const doc = res.json<{
      version: number;
      tasks: { id: string; steps: Record<string, unknown>[] }[];
    }>();
    expect(doc.version).toBe(4);
    const step = doc.tasks.find((t) => t.id === taskId)!.steps[0]!;
    expect(step).toMatchObject({
      id: stepId,
      input,
      resolvedInput: resolved,
      output,
      outputPreview: { messageId: output.messageId },
    });
    expect(step.toolExecutions).toEqual([
      expect.objectContaining({
        toolId: 'email.send',
        toolVersion: '1',
        status: 'succeeded',
        output,
        evidence,
        error: null,
        costMicroUsd: 12,
        durationMs: 345,
        startedAt: expect.any(String),
        finishedAt: expect.any(String),
      }),
    ]);
    expect(res.body).toContain(body);

    const row = await withContext(h.db, c.user, (trx) =>
      trx.selectFrom('connections').select('secret_ciphertext').executeTakeFirstOrThrow(),
    );
    const ct = row.secret_ciphertext!;
    for (const needle of [
      SMTP_PASSWORD,
      ct.toString('base64'),
      ct.toString('hex'),
      ct.toString('base64url'),
      c.token,
      TEST_PASSWORD,
    ])
      expect(res.body).not.toContain(needle);
    expect(res.body).not.toMatch(/password|token_hash|ciphertext|secret_key|argon2/i);
  });

  it('only exports the caller’s data', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    await seedTask(h.db, alice.user, { request: 'alice-only-request' });
    const res = await bob.request('POST', '/v1/account/export');
    expect(res.body).not.toContain('alice-only-request');
    expect(res.json<{ tasks: unknown[] }>().tasks).toEqual([]);
  });
});

describe('POST /v1/account/delete', () => {
  it('requires the password and the DELETE confirmation', async () => {
    const c = await newClient(h);
    const wrong = await c.request('POST', '/v1/account/delete', {
      password: 'not-the-password',
      confirmation: 'DELETE',
    });
    expect(wrong.statusCode).toBe(403);
    const noConfirm = await c.request('POST', '/v1/account/delete', {
      password: TEST_PASSWORD,
      confirmation: 'delete',
    });
    expect(noConfirm.statusCode).toBe(400);
    expect((await c.request('GET', '/v1/me')).statusCode).toBe(200);
  });

  it('deletes the user, their data and their tenant, and invalidates the session', async () => {
    const c = await newClient(h);
    const other = await newClient(h);
    const taskId = await seedTask(h.db, c.user, { request: 'to be erased' });
    await c.request('POST', '/v1/memories', { content: 'erase me' });
    await withContext(h.db, c.user, (trx) =>
      trx
        .insertInto('jobs')
        .values({
          kind: 'task.plan',
          tenant_id: c.user.tenantId,
          user_id: c.user.userId,
          task_id: taskId,
        })
        .execute(),
    );

    const res = await c.request('POST', '/v1/account/delete', {
      password: TEST_PASSWORD,
      confirmation: 'DELETE',
    });
    expect(res.statusCode).toBe(204);

    expect((await c.request('GET', '/v1/me')).statusCode).toBe(401);
    const login = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '10.99.0.1',
      payload: { email: c.user.email, password: TEST_PASSWORD, platform: 'ios' },
    });
    expect(login.statusCode).toBe(401);

    // Everything owned by the user is gone (checked with the user's own RLS context).
    const left = await withContext(h.db, c.user, async (trx) => ({
      users: await trx.selectFrom('users').select('id').execute(),
      tenants: await trx.selectFrom('tenants').select('id').execute(),
      tasks: await trx.selectFrom('tasks').select('id').execute(),
      memories: await trx.selectFrom('memories').select('id').execute(),
      sessions: await trx.selectFrom('sessions').select('id').execute(),
    }));
    expect(left).toEqual({ users: [], tenants: [], tasks: [], memories: [], sessions: [] });
    const jobs = await h.db
      .selectFrom('jobs')
      .select('id')
      .where('user_id', '=', c.user.userId)
      .execute();
    expect(jobs).toEqual([]);

    // The deletion is audited; other accounts are untouched.
    const audit = await sql<{ action: string; target_id: string | null }>`
      select action, target_id from admin_list_audit(50, null)`.execute(h.db);
    expect(audit.rows).toContainEqual({ action: 'account.deleted', target_id: c.user.userId });
    expect(audit.rows).toContainEqual({ action: 'tenant.deleted', target_id: c.user.tenantId });
    expect((await other.request('GET', '/v1/me')).statusCode).toBe(200);
  });

  it('keeps the tenant while other members remain, and clears the web cookie', async () => {
    const owner = await createTestUser(h.db);
    const memberId = crypto.randomUUID();
    await withContext(h.db, owner, (trx) =>
      trx
        .insertInto('users')
        .values({
          id: memberId,
          tenant_id: owner.tenantId,
          email: `member-${memberId.slice(0, 8)}@test.local`,
          display_name: 'Member',
          password_hash: 'x',
        })
        .execute(),
    );
    const cookie = await loginWeb(h.app, owner);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/account/delete',
      cookies: { jarvis_session: cookie },
      headers: { origin: WEB_ORIGIN },
      payload: { password: TEST_PASSWORD, confirmation: 'DELETE' },
    });
    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((ck) => ck.name === 'jarvis_session');
    expect(cleared?.value).toBe('');
    const tenant = await withContext(h.db, { tenantId: owner.tenantId, userId: memberId }, (trx) =>
      trx.selectFrom('tenants').select('id').execute(),
    );
    expect(tenant).toHaveLength(1);
  });
});
