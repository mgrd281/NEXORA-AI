import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SkillId, type Skill, type TimeZoneInfo } from '@jarvis/contracts';
import { withContext } from '../../../src/db/pool';
import { canonicalTimeZone } from '../../../src/lib/period';
import { createHarness, newClient, type Harness } from './support';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('skills', () => {
  it("lists the registry with the caller's availability and switches skills through the service", async () => {
    const c = await newClient(h);
    const list = await c.request('GET', '/v1/skills');
    expect(list.statusCode).toBe(200);
    const items = list.json<{ items: Skill[] }>().items;
    expect(items.map((s) => s.id)).toEqual(SkillId.options);

    const off = await c.request('PATCH', '/v1/skills/web-research', { enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json<Skill>()).toMatchObject({
      id: 'web-research',
      enabled: false,
      available: false,
      unavailableReason: 'DISABLED_BY_USER',
    });
    expect(h.fake.calls.setSkill.at(-1)).toEqual({ id: 'web-research', enabled: false });
    const me = (await c.request('GET', '/v1/me')).json<{
      preferences: { skills: { disabled: string[] } };
    }>();
    expect(me.preferences.skills.disabled).toEqual(['web-research']);
    expect(
      (await c.request('PATCH', '/v1/skills/web-research', { enabled: true })).json<Skill>()
        .enabled,
    ).toBe(true);
  });

  it("passes the service's refusals through (409) and validates the id and body", async () => {
    const c = await newClient(h);
    const planned = await c.request('PATCH', '/v1/skills/phone-calling', { enabled: true });
    expect(planned.statusCode).toBe(409);
    expect(planned.json().error.details.reason).toBe('SKILL_PLANNED');
    const core = await c.request('PATCH', '/v1/skills/workflow-planning', { enabled: false });
    expect(core.json().error.details.reason).toBe('SKILL_NOT_TOGGLEABLE');
    expect(
      (await c.request('PATCH', '/v1/skills/not-a-skill', { enabled: false })).statusCode,
    ).toBe(400);
    expect((await c.request('PATCH', '/v1/skills/translation', { enabled: 'no' })).statusCode).toBe(
      400,
    );
    // Skills cannot be written through PATCH /v1/me.
    const viaMe = await c.request('PATCH', '/v1/me', {
      preferences: { skills: { disabled: ['translation'] } },
    });
    expect(
      (await c.request('GET', '/v1/me')).json<{ preferences: { skills: { disabled: string[] } } }>()
        .preferences.skills.disabled,
    ).toEqual([]);
    expect([200, 400]).toContain(viaMe.statusCode);
  });
});

describe('time zones', () => {
  it('lists exactly the zones the server stores, sorted, with current offsets', async () => {
    const c = await newClient(h);
    const res = await c.request('GET', '/v1/meta/time-zones');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
    const zones = res.json<{ items: TimeZoneInfo[] }>().items;
    const ids = zones.map((z) => z.id);
    expect(ids.length).toBeGreaterThan(300);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'Europe/Berlin',
      'America/New_York',
      'Asia/Tokyo',
      'Australia/Sydney',
      'UTC',
      'Asia/Riyadh',
    ])
      expect(ids, id).toContain(id);
    expect(ids.some((id) => /^(posix|right)\/|^(posixrules|Factory|localtime)$/.test(id))).toBe(
      false,
    );
    expect(zones.find((z) => z.id === 'Asia/Tokyo')?.utcOffsetMinutes).toBe(540);
    expect(zones.find((z) => z.id === 'UTC')?.utcOffsetMinutes).toBe(0);
    // Every listed zone is accepted, in this exact spelling.
    const canonical = await withContext(h.db, c.user, async (trx) =>
      Promise.all(ids.map((id) => canonicalTimeZone(trx, id))),
    );
    expect(canonical).toEqual(ids);
    const set = await c.request('PATCH', '/v1/me', { timeZone: 'Asia/Riyadh' });
    expect(set.json<{ timeZone: string }>().timeZone).toBe('Asia/Riyadh');
  });

  it('needs a session', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/meta/time-zones' })).statusCode).toBe(
      401,
    );
  });
});
