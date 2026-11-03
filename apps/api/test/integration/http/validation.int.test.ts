/**
 * Client input Postgres cannot store (U+0000) or represent (tampered cursor
 * timestamps) is a 400 VALIDATION_FAILED, never a 500.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { createHarness, newClient, type Client, type Harness } from './support';

let h: Harness;
let c: Client;
beforeAll(async () => {
  h = await createHarness();
  c = await newClient(h);
});
afterAll(async () => {
  await h.close();
});

function expectInvalid(res: LightMyRequestResponse, path?: string) {
  expect(res.statusCode, res.body).toBe(400);
  const error = res.json<{
    error: { code: string; details?: { issues: { path: string }[] } };
  }>().error;
  expect(error.code).toBe('VALIDATION_FAILED');
  if (path !== undefined) expect(error.details?.issues.map((i) => i.path)).toContain(path);
}

const cursorAt = (t: string) =>
  Buffer.from(JSON.stringify({ t, i: '3f1c2b4e-8d9a-4c1b-9e2f-1a2b3c4d5e6f' })).toString(
    'base64url',
  );

describe('NUL characters in client text', () => {
  it('are rejected in JSON bodies', async () => {
    expectInvalid(await c.request('POST', '/v1/tasks', { request: 'a\u0000b' }), 'request');
    expectInvalid(await c.request('POST', '/v1/memories', { content: 'tea\u0000' }), 'content');
    expectInvalid(await c.request('PATCH', '/v1/me', { displayName: 'A\u0000' }), 'displayName');
    expectInvalid(
      await c.request('POST', '/v1/voice-sessions', { locale: 'en\u0000', engine: 'ios_speech' }),
      'locale',
    );
    // Nested values and object keys too.
    expectInvalid(
      await c.request('PATCH', '/v1/me', { preferences: { memory: { enabled: true, ['x\u0000']: true } } }),
    );
  });

  it('are rejected in query strings', async () => {
    expectInvalid(await c.request('GET', '/v1/memories?q=a%00b'), 'q');
  });

  it('are rejected on unauthenticated routes', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '10.88.0.1',
      payload: { email: c.user.email, password: c.user.password, platform: 'ios', deviceName: 'x\u0000' },
    });
    expectInvalid(res, 'deviceName');
  });

  it('leave ordinary text alone', async () => {
    const res = await c.request('POST', '/v1/memories', { content: 'Tea: Earl Grey é中' });
    expect(res.statusCode).toBe(201);
  });
});

describe('Tampered pagination cursors', () => {
  it.each(['/v1/tasks', '/v1/memories', '/v1/notifications'])(
    'with a year Postgres rejects are invalid on %s',
    async (path) => {
      const res = await c.request('GET', `${path}?cursor=${cursorAt('0000-01-01T00:00:00.000000Z')}`);
      expectInvalid(res);
      expect(res.json().error.message).toBe('Invalid cursor');
    },
  );

  it('with a year Postgres rejects are invalid on /v1/admin/users', async () => {
    const admin = await newClient(h, { admin: true });
    const res = await admin.request('GET', '/v1/admin/users?cursor=0000-01-01T00:00:00.000000Z');
    expectInvalid(res);
  });
});

describe('Postgres data errors caused by client input', () => {
  let probe: Harness;
  beforeAll(async () => {
    probe = await createHarness({
      routes: (app, deps) => {
        // Each probe makes Postgres reject a value the way unchecked client input would.
        app.get('/probe/nul-text', async () => {
          await sql`select ${'a\u0000b'}::text`.execute(deps.db);
        });
        app.get('/probe/nul-json', async () => {
          await sql`select ${'{"a":"\\u0000"}'}::jsonb`.execute(deps.db);
        });
        app.get('/probe/year-zero', async () => {
          await sql`select ${'0000-01-01T00:00:00Z'}::timestamptz`.execute(deps.db);
        });
        app.get('/probe/server-bug', async () => {
          await sql`select * from no_such_table`.execute(deps.db);
        });
      },
    });
  });
  afterAll(async () => {
    await probe.close();
  });

  it.each(['nul-text', 'nul-json', 'year-zero'])('%s is VALIDATION_FAILED', async (name) => {
    expectInvalid(await probe.app.inject({ method: 'GET', url: `/probe/${name}` }));
  });

  it('other database errors stay INTERNAL', async () => {
    const res = await probe.app.inject({ method: 'GET', url: '/probe/server-bug' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL');
  });
});
