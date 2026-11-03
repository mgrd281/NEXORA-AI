import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Memory } from '@jarvis/contracts';
import { createHarness, newClient, type Client, type Harness } from './support';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

type Page = { items: Memory[]; nextCursor: string | null };

async function create(c: Client, content: string, kind?: 'fact' | 'preference') {
  const res = await c.request('POST', '/v1/memories', kind ? { content, kind } : { content });
  expect(res.statusCode).toBe(201);
  return res.json<Memory>();
}

async function search(c: Client, q: string) {
  const res = await c.request('GET', `/v1/memories?q=${encodeURIComponent(q)}`);
  expect(res.statusCode).toBe(200);
  return res
    .json<Page>()
    .items.map((m) => m.content)
    .sort();
}

describe('memories', () => {
  it('creates user memories with defaults', async () => {
    const c = await newClient(h);
    const m = await create(c, '  My sister is called Lena  ');
    expect(m).toMatchObject({
      kind: 'fact',
      content: 'My sister is called Lena',
      source: 'user',
      sourceTaskId: null,
    });
    const p = await create(c, 'Keep summaries short', 'preference');
    expect(p.kind).toBe('preference');
    expect((await c.request('POST', '/v1/memories', { content: '' })).statusCode).toBe(400);
    expect(
      (await c.request('POST', '/v1/memories', { content: 'x'.repeat(1001) })).statusCode,
    ).toBe(400);
  });

  it('paginates newest first', async () => {
    const c = await newClient(h);
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await create(c, `memory ${i}`)).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/memories?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page: Page = (await c.request('GET', url)).json<Page>();
      seen.push(...page.items.map((m) => m.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...made].reverse());
  });

  it('searches by word (full text) and by literal substring', async () => {
    const c = await newClient(h);
    await create(c, 'I drink oat milk in coffee');
    await create(c, 'My dentist is Dr. Weber');
    await create(c, 'Discount is 50% off_peak');
    await create(c, 'Meine Lieblingsfarbe ist Grün');
    expect(await search(c, 'coffee')).toEqual(['I drink oat milk in coffee']);
    expect(await search(c, 'Dentist')).toEqual(['My dentist is Dr. Weber']);
    expect(await search(c, 'denti')).toEqual(['My dentist is Dr. Weber']); // substring
    expect(await search(c, 'grün')).toEqual(['Meine Lieblingsfarbe ist Grün']);
    // LIKE wildcards in the query match literally.
    expect(await search(c, '%')).toEqual(['Discount is 50% off_peak']);
    expect(await search(c, '_')).toEqual(['Discount is 50% off_peak']);
    expect(await search(c, 'nothing-matches')).toEqual([]);
    // A blank query lists everything.
    expect(await search(c, '   ')).toHaveLength(4);
  });

  it('updates and deletes', async () => {
    const c = await newClient(h);
    const m = await create(c, 'Lives in Berlin');
    const upd = await c.request('PATCH', `/v1/memories/${m.id}`, {
      content: 'Lives in Hamburg',
      kind: 'fact',
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json<Memory>()).toMatchObject({ id: m.id, content: 'Lives in Hamburg' });
    expect(new Date(upd.json<Memory>().updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(m.updatedAt).getTime(),
    );
    const noop = await c.request('PATCH', `/v1/memories/${m.id}`, {});
    expect(noop.json<Memory>().content).toBe('Lives in Hamburg');
    expect(await search(c, 'hamburg')).toEqual(['Lives in Hamburg']);

    expect((await c.request('DELETE', `/v1/memories/${m.id}`)).statusCode).toBe(204);
    expect((await c.request('DELETE', `/v1/memories/${m.id}`)).statusCode).toBe(404);
    expect((await c.request('PATCH', `/v1/memories/${m.id}`, { content: 'x' })).statusCode).toBe(
      404,
    );
  });

  it('deletes all and reports the count', async () => {
    const c = await newClient(h);
    const other = await newClient(h);
    await create(c, 'one');
    await create(c, 'two');
    await create(c, 'three');
    await create(other, 'not mine');
    const res = await c.request('DELETE', '/v1/memories');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 3 });
    expect((await c.request('GET', '/v1/memories')).json<Page>().items).toEqual([]);
    expect((await other.request('GET', '/v1/memories')).json<Page>().items).toHaveLength(1);
  });

  it('isolates tenants', async () => {
    const alice = await newClient(h);
    const bob = await newClient(h);
    const m = await create(alice, 'Alice secret memory');
    expect((await bob.request('GET', '/v1/memories?q=secret')).json<Page>().items).toEqual([]);
    expect((await bob.request('PATCH', `/v1/memories/${m.id}`, { content: 'x' })).statusCode).toBe(
      404,
    );
    expect((await bob.request('DELETE', `/v1/memories/${m.id}`)).statusCode).toBe(404);
    expect((await bob.request('DELETE', '/v1/memories')).json()).toEqual({ deleted: 0 });
    expect(await search(alice, 'secret')).toEqual(['Alice secret memory']);
  });
});
