import { get as httpGet, type ClientRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@jarvis/contracts';
import { createListener } from '../../../src/db/listener';
import { withContext, type DbContext } from '../../../src/db/pool';
import { appendEvent, EVENTS_CHANNEL, publishEphemeral } from '../../../src/modules/events/events';
import { TEST_APP_URL } from '../env';
import { MAX_STREAMS_PER_USER, SESSIONS_CHANNEL } from '../../../src/modules/stream/routes';
import { createHarness, newClient, seedTask, type Client, type Harness } from './support';

let h: Harness;
let listener: ReturnType<typeof createListener>;
let base: string;

beforeAll(async () => {
  listener = createListener(TEST_APP_URL);
  h = await createHarness({ listen: listener.listen });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await h.close();
  await listener.close();
});

interface Received {
  id: string | null;
  event: string | null;
  data: StreamEvent;
}

/** Opens a raw HTTP request (own socket, no keep-alive pool) and resolves on the response head. */
function get(url: string, headers: Record<string, string>) {
  return new Promise<{ req: ClientRequest; res: IncomingMessage }>((resolve, reject) => {
    const req = httpGet(url, { headers, agent: false }, (res) => resolve({ req, res }));
    req.on('error', reject);
  });
}

/** Minimal SSE client: parses frames as they arrive. */
async function openStream(token: string, opts: { lastEventId?: string; query?: string } = {}) {
  const { req, res } = await get(`${base}/v1/events${opts.query ?? ''}`, {
    authorization: `Bearer ${token}`,
    accept: 'text/event-stream',
    ...(opts.lastEventId ? { 'last-event-id': opts.lastEventId } : {}),
  });
  const received: Received[] = [];
  let raw = '';
  let buf = '';
  res.setEncoding('utf8');
  res.on('data', (text: string) => {
    raw += text;
    buf += text;
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const fields: Record<string, string> = {};
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) continue;
        const i = line.indexOf(':');
        if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1).trimStart();
      }
      if (fields.data !== undefined)
        received.push({
          id: fields.id ?? null,
          event: fields.event ?? null,
          data: JSON.parse(fields.data) as StreamEvent,
        });
    }
  });
  res.on('error', () => undefined);
  return {
    res,
    received,
    raw: () => raw,
    async waitFor(pred: (r: Received[]) => boolean, timeoutMs = 5000) {
      const until = Date.now() + timeoutMs;
      while (!pred(received)) {
        if (Date.now() > until) throw new Error(`timed out; got ${JSON.stringify(received)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    close() {
      req.destroy();
    },
  };
}

async function emit(
  ctx: DbContext,
  taskId: string | null,
  type: 'task.created' | 'connection.changed',
  data = {},
) {
  return withContext(h.db, ctx, (trx) => appendEvent(trx, ctx, { taskId, type, data }));
}

describe('GET /v1/events', () => {
  it('requires authentication', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/events' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
    const bad = await h.app.inject({
      method: 'GET',
      url: '/v1/events',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('streams the user’s own events and never another user’s', async () => {
    const alice: Client = await newClient(h);
    const bob: Client = await newClient(h);
    const aliceTask = await seedTask(h.db, alice.user, { title: 'Alice task' });
    const bobTask = await seedTask(h.db, bob.user, { title: 'Bob task' });

    const stream = await openStream(alice.token);
    try {
      expect(stream.res.statusCode).toBe(200);
      expect(stream.res.headers['content-type']).toMatch(/^text\/event-stream/);
      expect(stream.res.headers['cache-control']).toBe('no-cache');
      expect(stream.res.headers['x-accel-buffering']).toBe('no');
      await new Promise((r) => setTimeout(r, 100)); // subscription in place

      const bobId = await emit(bob.user, bobTask, 'task.created', { status: 'QUEUED' });
      await publishEphemeral(h.db, bob.user, {
        taskId: bobTask,
        type: 'task.answer.delta',
        data: { text: 'bob-secret-delta' },
      });
      const aliceId = await emit(alice.user, aliceTask, 'task.created', { status: 'QUEUED' });
      await publishEphemeral(h.db, alice.user, {
        taskId: aliceTask,
        type: 'task.answer.delta',
        data: { text: 'hello alice' },
      });
      const accountId = await emit(alice.user, null, 'connection.changed', {
        connectionId: aliceTask,
        provider: 'web',
        status: 'active',
      });

      await stream.waitFor((r) => r.length >= 3);
      await new Promise((r) => setTimeout(r, 200)); // give a leaked event time to show up
      expect(stream.raw()).toMatch(/^retry: 3000\n\n/);
      expect(stream.received).toEqual([
        {
          id: String(aliceId),
          event: 'message',
          data: expect.objectContaining({
            id: String(aliceId),
            type: 'task.created',
            taskId: aliceTask,
            data: { status: 'QUEUED' },
          }),
        },
        {
          id: null,
          event: 'message',
          data: expect.objectContaining({
            type: 'task.answer.delta',
            taskId: aliceTask,
            data: { text: 'hello alice' },
          }),
        },
        {
          id: String(accountId),
          event: 'message',
          data: expect.objectContaining({ type: 'connection.changed', taskId: null }),
        },
      ]);
      expect(stream.raw()).not.toContain(bobTask);
      expect(stream.raw()).not.toContain('bob-secret-delta');
      expect(stream.raw()).not.toContain(`id: ${bobId}\n`);
    } finally {
      stream.close();
    }
  });

  it('ignores forged notifications that point at another user’s event', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    const bobTask = await seedTask(h.db, bob.user);
    const stream = await openStream(alice.token);
    try {
      await new Promise((r) => setTimeout(r, 100));
      const bobId = await emit(bob.user, bobTask, 'task.created', { status: 'secret' });
      // A notice claiming to be for Alice but naming Bob's row: RLS refuses to load it.
      await sql`select pg_notify('jarvis_events', ${JSON.stringify({ u: alice.user.userId, id: bobId })})`.execute(
        h.db,
      );
      const marker = await emit(alice.user, null, 'connection.changed', { status: 'active' });
      await stream.waitFor((r) => r.some((e) => e.id === String(marker)));
      expect(stream.received.map((e) => e.id)).toEqual([String(marker)]);
      expect(stream.raw()).not.toContain(bobTask);
    } finally {
      stream.close();
    }
  });

  it('replays events after Last-Event-ID (header or query) for this user only', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    const task = await seedTask(h.db, alice.user);
    const bobTask = await seedTask(h.db, bob.user);
    const first = await emit(alice.user, task, 'task.created');
    await emit(bob.user, bobTask, 'task.created');
    const second = await emit(alice.user, task, 'connection.changed', { status: 'active' });
    const third = await emit(alice.user, task, 'connection.changed', { status: 'error' });

    const viaHeader = await openStream(alice.token, { lastEventId: String(first) });
    try {
      await viaHeader.waitFor((r) => r.length >= 2);
      expect(viaHeader.received.map((r) => r.id)).toEqual([String(second), String(third)]);
      // Live events continue after the replay without duplicates.
      const fourth = await emit(alice.user, task, 'connection.changed', { status: 'active' });
      await viaHeader.waitFor((r) => r.length >= 3);
      await new Promise((r) => setTimeout(r, 150));
      expect(viaHeader.received.map((r) => r.id)).toEqual([
        String(second),
        String(third),
        String(fourth),
      ]);
    } finally {
      viaHeader.close();
    }

    const viaQuery = await openStream(alice.token, { query: `?lastEventId=${second}` });
    try {
      await viaQuery.waitFor((r) => r.length >= 2);
      expect(viaQuery.received.map((r) => r.id)[0]).toBe(String(third));
      expect(viaQuery.raw()).not.toContain(bobTask);
    } finally {
      viaQuery.close();
    }
  });

  it('caps concurrent streams per user and frees a slot on disconnect', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    const closers: (() => void)[] = [];
    try {
      for (let i = 0; i < MAX_STREAMS_PER_USER; i++) {
        const s = await openStream(alice.token);
        expect(s.res.statusCode).toBe(200);
        closers.push(() => s.close());
      }
      const refused = await get(`${base}/v1/events`, { authorization: `Bearer ${alice.token}` });
      expect(refused.res.statusCode).toBe(429);
      refused.res.resume();
      // Other users are unaffected.
      const other = await openStream(bob.token);
      expect(other.res.statusCode).toBe(200);
      other.close();
      // Closing one stream frees a slot.
      closers.pop()!();
      let status = 0;
      for (let i = 0; i < 50 && status !== 200; i++) {
        await new Promise((r) => setTimeout(r, 20));
        const retry = await get(`${base}/v1/events`, { authorization: `Bearer ${alice.token}` });
        status = retry.res.statusCode ?? 0;
        if (status === 200) closers.push(() => retry.req.destroy());
        else retry.res.resume();
      }
      expect(status).toBe(200);
    } finally {
      for (const close of closers) close();
    }
  });

  it('releases the subscription when the client disconnects', async () => {
    const alice = await newClient(h);
    const active: Record<string, number> = {};
    const counting = await createHarness({
      listen: async (channel, fn) => {
        active[channel] = (active[channel] ?? 0) + 1;
        const stop = await listener.listen(channel, fn);
        return async () => {
          active[channel]!--;
          await stop();
        };
      },
    });
    await counting.app.listen({ port: 0, host: '127.0.0.1' });
    const waitFor = async (pred: () => boolean) => {
      const until = Date.now() + 2000;
      while (!pred() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    };
    try {
      const url = `http://127.0.0.1:${(counting.app.server.address() as AddressInfo).port}/v1/events`;
      const first = await get(url, { authorization: `Bearer ${alice.token}` });
      const second = await get(url, { authorization: `Bearer ${alice.token}` });
      expect(first.res.statusCode).toBe(200);
      expect(second.res.statusCode).toBe(200);
      // One events subscription per stream; one session-end watch per process.
      await waitFor(() => active[EVENTS_CHANNEL] === 2);
      expect(active).toEqual({ [EVENTS_CHANNEL]: 2, [SESSIONS_CHANNEL]: 1 });
      first.req.destroy();
      second.req.destroy();
      await waitFor(() => active[EVENTS_CHANNEL] === 0);
      expect(active[EVENTS_CHANNEL]).toBe(0);
    } finally {
      await counting.close();
    }
    // Shutdown releases the session-end watch.
    expect(active[SESSIONS_CHANNEL]).toBe(0);
  });

  it('ends open streams when the server shuts down', async () => {
    const alice = await newClient(h);
    const other = await createHarness({ listen: listener.listen });
    await other.app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(other.app.server.address() as AddressInfo).port}/v1/events`;
    const { res } = await get(url, { authorization: `Bearer ${alice.token}` });
    expect(res.statusCode).toBe(200);
    const ended = new Promise<string>((resolve) => {
      res.on('end', () => resolve('ended'));
      res.on('close', () => resolve('ended'));
    });
    res.resume();
    const closed = other.close().then(() => 'closed');
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 5000));
    expect(await Promise.race([closed, timeout])).toBe('closed');
    expect(await Promise.race([ended, timeout])).toBe('ended');
  });
});
