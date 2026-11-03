import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Notification } from '@jarvis/contracts';
import { withContext } from '../../../src/db/pool';
import {
  createHarness,
  newClient,
  seedNotification,
  seedTask,
  timeline,
  type Harness,
} from './support';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

type Page = { items: Notification[]; nextCursor: string | null };

describe('notifications', () => {
  it('paginates newest first with localisation parameters', async () => {
    const c = await newClient(h);
    const taskId = await seedTask(h.db, c.user);
    const ids: string[] = [];
    for (const at of timeline(5))
      ids.push(await seedNotification(h.db, c.user, { createdAt: at, taskId }));
    const first = (await c.request('GET', '/v1/notifications?limit=3')).json<Page>();
    expect(first.items.map((n) => n.id)).toEqual(ids.slice(0, 3));
    expect(first.items[0]).toMatchObject({
      kind: 'task_completed',
      taskId,
      data: { taskTitle: 'Seeded task' },
      readAt: null,
    });
    const second = (
      await c.request(
        'GET',
        `/v1/notifications?limit=3&cursor=${encodeURIComponent(first.nextCursor!)}`,
      )
    ).json<Page>();
    expect(second.items.map((n) => n.id)).toEqual(ids.slice(3));
    expect(second.nextCursor).toBeNull();
  });

  it('marks selected or all notifications read', async () => {
    const c = await newClient(h);
    const [a, b, d] = [
      await seedNotification(h.db, c.user),
      await seedNotification(h.db, c.user),
      await seedNotification(h.db, c.user),
    ];
    const res = await c.request('POST', '/v1/notifications/read', { ids: [a] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const readMap = async () =>
      Object.fromEntries(
        (await c.request('GET', '/v1/notifications'))
          .json<Page>()
          .items.map((n) => [n.id, !!n.readAt]),
      );
    expect(await readMap()).toEqual({ [a]: true, [b]: false, [d]: false });
    await c.request('POST', '/v1/notifications/read', { ids: [] });
    expect(await readMap()).toEqual({ [a]: true, [b]: false, [d]: false });
    await c.request('POST', '/v1/notifications/read', {});
    expect(await readMap()).toEqual({ [a]: true, [b]: true, [d]: true });
  });

  it('cannot mark another tenant’s notifications read', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    const n = await seedNotification(h.db, alice.user);
    await bob.request('POST', '/v1/notifications/read', { ids: [n] });
    await bob.request('POST', '/v1/notifications/read', {});
    const items = (await alice.request('GET', '/v1/notifications')).json<Page>().items;
    expect(items.map((i) => i.readAt)).toEqual([null]);
    expect((await bob.request('GET', '/v1/notifications')).json<Page>().items).toEqual([]);
  });
});

describe('voice sessions', () => {
  it('records start and end metadata only', async () => {
    const c = await newClient(h);
    const start = await c.request('POST', '/v1/voice-sessions', {
      locale: 'de-DE',
      engine: 'ios_speech',
    });
    expect(start.statusCode).toBe(201);
    const s = start.json<{ id: string; startedAt: string; endedAt: string | null }>();
    expect(s.endedAt).toBeNull();

    const end = await c.request('POST', `/v1/voice-sessions/${s.id}/end`, {
      outcome: 'submitted',
      transcriptChars: 42,
    });
    expect(end.statusCode).toBe(200);
    const ended = end.json<{ endedAt: string }>();
    expect(ended.endedAt).not.toBeNull();

    // Repeating the end (e.g. a network retry) keeps the first recorded outcome.
    const again = await c.request('POST', `/v1/voice-sessions/${s.id}/end`, {
      outcome: 'cancelled',
      transcriptChars: 0,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(end.json());
    const row = await withContext(h.db, c.user, (trx) =>
      trx.selectFrom('voice_sessions').selectAll().where('id', '=', s.id).executeTakeFirstOrThrow(),
    );
    expect(row).toMatchObject({ outcome: 'submitted', transcript_chars: 42, locale: 'de-DE' });
  });

  it('validates input and isolates tenants', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    expect(
      (await alice.request('POST', '/v1/voice-sessions', { locale: 'en-US', engine: 'siri' }))
        .statusCode,
    ).toBe(400);
    const s = (
      await alice.request('POST', '/v1/voice-sessions', {
        locale: 'en-US',
        engine: 'browser_speech',
      })
    ).json<{ id: string }>();
    const res = await bob.request('POST', `/v1/voice-sessions/${s.id}/end`, {
      outcome: 'error',
      transcriptChars: 0,
      errorCode: 'not-allowed',
    });
    expect(res.statusCode).toBe(404);
  });
});
