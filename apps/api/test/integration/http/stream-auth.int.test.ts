/**
 * The SSE stream stays bound to the session that opened it: revoking or
 * logging out that session, its expiry, disabling or deleting the user ends
 * the stream at once (pg_notify on jarvis_sessions, handled by every API
 * instance), the heartbeat re-validates the session as a backstop, and a
 * client that disconnects before the stream is set up leaks nothing.
 */
import { get as httpGet, type ClientRequest, type IncomingMessage } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createListener } from '../../../src/db/listener';
import { withContext, type DbContext } from '../../../src/db/pool';
import { registerAuthRoutes } from '../../../src/modules/auth/routes';
import { appendEvent, EVENTS_CHANNEL, publishEphemeral } from '../../../src/modules/events/events';
import {
  HEARTBEAT_MS,
  MAX_STREAMS_PER_USER,
  registerStreamRoutes,
  SESSIONS_CHANNEL,
} from '../../../src/modules/stream/routes';
import { registerRoutes } from '../../../src/routes';
import type { AppDeps } from '../../../src/services';
import { TEST_APP_URL, TEST_OWNER_URL } from '../env';
import { TEST_PASSWORD } from '../helpers';
import { createHarness, login, newClient, seedTask, type Client, type Harness } from './support';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let listener: ReturnType<typeof createListener>;
let owner: pg.Client;
/** The instance serving the streams. */
let h: Harness;
/** A second API instance: revocations made there must reach streams on `h`. */
let other: Harness;

async function serve(harness: Harness): Promise<string> {
  await harness.app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(harness.app.server.address() as AddressInfo).port}`;
}
let base: string;

beforeAll(async () => {
  listener = createListener(TEST_APP_URL);
  owner = new pg.Client({ connectionString: TEST_OWNER_URL });
  await owner.connect();
  h = await createHarness({ listen: listener.listen });
  other = await createHarness();
  base = await serve(h);
});
afterAll(async () => {
  await h.close();
  await other.close();
  await listener.close();
  await owner.end();
});

function get(url: string, headers: Record<string, string>) {
  return new Promise<{ req: ClientRequest; res: IncomingMessage }>((resolve, reject) => {
    const req = httpGet(url, { headers, agent: false }, (res) => resolve({ req, res }));
    req.on('error', reject);
  });
}

async function openStream(token: string, url = `${base}/v1/events`) {
  const { req, res } = await get(url, {
    authorization: `Bearer ${token}`,
    accept: 'text/event-stream',
  });
  let raw = '';
  let ended = false;
  res.setEncoding('utf8');
  res.on('data', (t: string) => {
    raw += t;
  });
  res.on('end', () => (ended = true));
  res.on('close', () => (ended = true));
  res.on('error', () => undefined);
  return {
    status: res.statusCode,
    raw: () => raw,
    ended: () => ended,
    close: () => req.destroy(),
  };
}
type Stream = Awaited<ReturnType<typeof openStream>>;

async function waitFor(pred: () => boolean, timeoutMs = 3000, what = 'condition') {
  const until = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** Emits a marker event and waits until the stream shows it: the stream is live. */
async function waitLive(stream: Stream, ctx: DbContext) {
  const id = await withContext(h.db, ctx, (trx) =>
    appendEvent(trx, ctx, { taskId: null, type: 'connection.changed', data: { status: 'active' } }),
  );
  await waitFor(() => stream.raw().includes(`id: ${id}\n`), 5000, 'the stream to go live');
}

/** Emits a persisted approval summary and an ephemeral answer delta for the user. */
async function emitSecrets(ctx: DbContext, label: string) {
  const taskId = await seedTask(h.db, ctx);
  await withContext(h.db, ctx, (trx) =>
    appendEvent(trx, ctx, {
      taskId,
      type: 'approval.requested',
      data: { approvalId: taskId, stepId: taskId, summary: `SECRET-${label}` },
    }),
  );
  await publishEphemeral(h.db, ctx, {
    taskId,
    type: 'task.answer.delta',
    data: { text: `DELTA-${label}` },
  });
}

/** The change has just been made: nothing emitted from now on may reach the stream. */
async function expectCutOff(stream: Stream, ctx: DbContext, label: string) {
  await emitSecrets(ctx, label);
  await waitFor(() => stream.ended(), 3000, 'the stream to end');
  await sleep(200); // a late delivery would show up here
  expect(stream.raw()).not.toContain(`SECRET-${label}`);
  expect(stream.raw()).not.toContain(`DELTA-${label}`);
}

async function sessionsOf(c: Client) {
  const res = await c.request('GET', '/v1/auth/sessions');
  return res.json<{ items: { id: string; current: boolean }[] }>().items;
}

describe('GET /v1/events ends when the session stops being valid', () => {
  it('revokeSession from another device (served by another API instance)', async () => {
    const victim = await newClient(h);
    // A second sign-in of the same user (the phone that revokes the laptop).
    const phoneToken = await login(h.app, victim.user);
    const laptop = await openStream(victim.token);
    const phone = await openStream(phoneToken);
    try {
      expect(laptop.status).toBe(200);
      await waitLive(laptop, victim.user);
      await waitLive(phone, victim.user);
      const laptopSession = (await sessionsOf(victim)).find((s) => s.current)!;
      const revoke = await other.app.inject({
        method: 'DELETE',
        url: `/v1/auth/sessions/${laptopSession.id}`,
        headers: { authorization: `Bearer ${phoneToken}` },
      });
      expect(revoke.statusCode).toBe(204);
      await expectCutOff(laptop, victim.user, 'revoke');
      // Only the revoked session's stream ends; the phone keeps receiving.
      expect(phone.ended()).toBe(false);
      expect(phone.raw()).toContain('SECRET-revoke');
      expect(phone.raw()).toContain('DELTA-revoke');
    } finally {
      laptop.close();
      phone.close();
    }
  });

  it('logout', async () => {
    const c = await newClient(h);
    const stream = await openStream(c.token);
    try {
      await waitLive(stream, c.user);
      expect((await c.request('POST', '/v1/auth/logout')).statusCode).toBe(204);
      await expectCutOff(stream, c.user, 'logout');
    } finally {
      stream.close();
    }
  });

  it('expiry set in the past while the stream is open', async () => {
    const c = await newClient(h);
    const stream = await openStream(c.token);
    try {
      await waitLive(stream, c.user);
      await owner.query(
        `update sessions set expires_at = now() - interval '1 second' where user_id = $1`,
        [c.user.userId],
      );
      await expectCutOff(stream, c.user, 'expired');
    } finally {
      stream.close();
    }
  });

  it('a disabled user', async () => {
    const c = await newClient(h);
    const stream = await openStream(c.token);
    try {
      await waitLive(stream, c.user);
      await owner.query(`update users set status = 'disabled' where id = $1`, [c.user.userId]);
      await expectCutOff(stream, c.user, 'disabled');
    } finally {
      stream.close();
    }
  });

  it('account deletion', async () => {
    const c = await newClient(h);
    const stream = await openStream(c.token);
    try {
      await waitLive(stream, c.user);
      const del = await c.request('POST', '/v1/account/delete', {
        password: TEST_PASSWORD,
        confirmation: 'DELETE',
      });
      expect(del.statusCode).toBe(204);
      await waitFor(() => stream.ended(), 3000, 'the stream to end');
    } finally {
      stream.close();
    }
  });

  it('the session reaching its expiry time', async () => {
    const c = await newClient(h);
    await owner.query(
      `update sessions set expires_at = now() + interval '1500 milliseconds' where user_id = $1`,
      [c.user.userId],
    );
    const stream = await openStream(c.token);
    try {
      expect(stream.status).toBe(200);
      await waitLive(stream, c.user);
      await waitFor(() => stream.ended(), 4000, 'the stream to end at expiry');
      await emitSecrets(c.user, 'natural-expiry');
      await sleep(200);
      expect(stream.raw()).not.toContain('SECRET-natural-expiry');
    } finally {
      stream.close();
    }
  });
});

describe('GET /v1/events heartbeat re-validation', () => {
  it('ends a stream whose revocation notice was missed', async () => {
    // This instance never hears jarvis_sessions notices (e.g. its LISTEN
    // connection was reconnecting), so only the heartbeat check can end it.
    const deaf = await createHarness({
      listen: async (channel, fn) =>
        channel === SESSIONS_CHANNEL ? async () => {} : listener.listen(channel, fn),
      routes: (app, deps) => {
        registerAuthRoutes(app, deps);
        registerStreamRoutes(app, deps, { heartbeatMs: 100 });
      },
    });
    const url = `${await serve(deaf)}/v1/events`;
    try {
      const user = (await newClient(h)).user;
      const token = await login(deaf.app, user);
      const stream = await openStream(token, url);
      try {
        await waitLive(stream, user);
        await sleep(300); // several heartbeats pass while the session is valid
        expect(stream.ended()).toBe(false);
        await owner.query(`update sessions set revoked_at = now() where user_id = $1`, [
          user.userId,
        ]);
        await waitFor(() => stream.ended(), 3000, 'the heartbeat to end the stream');
        await emitSecrets(user, 'heartbeat');
        await sleep(200);
        expect(stream.raw()).not.toContain('SECRET-heartbeat');
        expect(stream.raw()).not.toContain('DELTA-heartbeat');
      } finally {
        stream.close();
      }
    } finally {
      await deaf.close();
    }
  });
});

describe('GET /v1/events client disconnects before the stream is set up', () => {
  it('leaks no per-user slot, heartbeat timer or listener', async () => {
    let eventSubscriptions = 0;
    const listen: AppDeps['listen'] = async (channel, fn) => {
      const stop = await listener.listen(channel, fn);
      if (channel !== EVENTS_CHANNEL) return stop;
      eventSubscriptions++;
      return async () => {
        eventSubscriptions--;
        await stop();
      };
    };
    // Authentication is slow enough for the client to give up while it runs.
    const slow = await createHarness({
      listen,
      routes: async (app, deps) => {
        app.addHook('onRequest', async (req) => {
          if (req.headers['x-test-slow-auth']) await sleep(150);
        });
        await registerRoutes(app, deps);
      },
    });
    const origin = await serve(slow);
    const port = Number(new URL(origin).port);

    const heartbeats = new Set<unknown>();
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const setSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      const t = realSetInterval(fn, ms);
      if (ms === HEARTBEAT_MS) heartbeats.add(t);
      return t;
    }) as typeof setInterval);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(((
      t?: Parameters<typeof clearInterval>[0],
    ) => {
      heartbeats.delete(t);
      realClearInterval(t);
    }) as typeof clearInterval);

    const closers: (() => void)[] = [];
    try {
      const { token } = await newClient(slow);
      for (let i = 0; i < MAX_STREAMS_PER_USER + 2; i++) {
        await new Promise<void>((resolve, reject) => {
          const s = connect(port, '127.0.0.1', () => {
            s.write(
              `GET /v1/events HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\nX-Test-Slow-Auth: 1\r\n\r\n`,
            );
            setTimeout(() => {
              s.destroy();
              resolve();
            }, 20);
          });
          s.on('error', reject);
        });
      }
      await sleep(400); // every handler has run against its closed socket

      expect(eventSubscriptions).toBe(0);
      expect(heartbeats.size).toBe(0);
      // Every slot is still free.
      for (let i = 0; i < MAX_STREAMS_PER_USER; i++) {
        const s = await openStream(token, `${origin}/v1/events`);
        closers.push(s.close);
        expect(s.status, `stream ${i + 1}`).toBe(200);
      }
    } finally {
      for (const close of closers) close();
      await sleep(100);
      setSpy.mockRestore();
      clearSpy.mockRestore();
      await slow.close();
    }
  });
});
