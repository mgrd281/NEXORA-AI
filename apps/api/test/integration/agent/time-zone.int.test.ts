/**
 * Time zones. The budget period (currentMonth) never runs a statement that can
 * fail inside the caller's transaction: a stored zone Postgres does not know
 * falls back to UTC and the transaction stays usable, so the user's tasks keep
 * working. Only zones that both Node (Intl) and Postgres understand can be
 * stored — through PATCH /v1/me and the operator CLI — in Postgres's spelling.
 */
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Me } from '@jarvis/contracts';
import { withContext } from '../../../src/db/pool';
import { currentMonth } from '../../../src/lib/period';
import { loadAgentContext } from '../../../src/modules/agent/context';
import { TEST_APP_URL, TEST_OWNER_URL } from '../env';
import {
  createHarness as createHttpHarness,
  newClient,
  type Harness as HttpHarness,
} from '../http/support';
import { createHarness, detail, drain, newUser, type Harness } from './harness';

/** Neither Node nor Postgres knows this one. */
const UNKNOWN = 'Mars/Olympus_Mons';

let h: Harness;
let http: HttpHarness;
/**
 * A zone Node's ICU accepts but this Postgres rejects (ICU keeps legacy links
 * such as Asia/Calcutta that some tzdata builds drop). Which ones exist
 * depends on both builds, so it is looked up; null when the builds agree.
 */
let icuOnly: string | null = null;

beforeAll(async () => {
  h = await createHarness();
  http = await createHttpHarness();
  const c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  try {
    const rows = await c.query<{ name: string }>('SELECT name FROM pg_timezone_names');
    const known = new Set(rows.rows.map((r) => r.name.toLowerCase()));
    const candidates = [
      'Asia/Calcutta',
      'Europe/Kiev',
      'Asia/Saigon',
      'Asia/Katmandu',
      'America/Buenos_Aires',
      ...Intl.supportedValuesOf('timeZone'),
    ];
    icuOnly = candidates.find((tz) => !known.has(tz.toLowerCase())) ?? null;
  } finally {
    await c.end();
  }
});
afterAll(async () => {
  await http.close();
  await h.close();
});

async function setStoredZone(user: { tenantId: string; userId: string }, tz: string) {
  // Written directly, as rows stored before validation existed would be.
  await withContext(h.db, user, (trx) =>
    trx.updateTable('users').set({ time_zone: tz }).where('id', '=', user.userId).execute(),
  );
}

describe('currentMonth', () => {
  it('falls back to UTC for an unknown zone without aborting the caller’s transaction', async () => {
    const user = await newUser(h.db);
    await withContext(h.db, user, async (trx) => {
      const utc = await currentMonth(trx, 'UTC');
      expect(await currentMonth(trx, UNKNOWN)).toEqual(utc);
      if (icuOnly) expect(await currentMonth(trx, icuOnly)).toEqual(utc);
      // Still usable: nothing failed inside it.
      const { rows } = await sql<{ ok: number }>`select 1 as ok`.execute(trx);
      expect(rows[0]!.ok).toBe(1);
    });
  });

  it('uses the zone when Postgres knows it, in any letter case', async () => {
    const user = await newUser(h.db);
    await withContext(h.db, user, async (trx) => {
      const utc = await currentMonth(trx, 'UTC');
      const kiritimati = await currentMonth(trx, 'Pacific/Kiritimati'); // UTC+14
      expect(kiritimati.start.getTime()).not.toBe(utc.start.getTime());
      expect(await currentMonth(trx, 'pacific/kiritimati')).toEqual(kiritimati);
    });
  });
});

describe('a stored zone Postgres does not know', () => {
  it('still lets the user’s tasks plan and run, with the budget period in UTC', async () => {
    const user = await newUser(h.db);
    await setStoredZone(user, icuOnly ?? UNKNOWN);
    const s = await h.services.tasks.create(
      user,
      { request: 'remember that my time zone is odd', source: 'text' },
      {},
    );
    await drain(h.worker);
    const d = await detail(h.db, user, s.id);
    expect(d.error).toBeNull();
    expect(d.status).toBe('COMPLETED');

    await setStoredZone(user, UNKNOWN);
    const agent = await withContext(h.db, user, (trx) =>
      loadAgentContext(trx, h.config, user.userId),
    );
    // What the planner and the budget use: a zone both Node and Postgres can work with.
    expect(agent.account.timeZone).toBe('UTC');
  });
});

describe('storing a time zone', () => {
  it('PATCH /v1/me rejects zones Postgres cannot use and stores the canonical spelling', async (ctx) => {
    const c = await newClient(http);
    const berlin = await c.request('PATCH', '/v1/me', { timeZone: 'europe/berlin' });
    expect(berlin.statusCode).toBe(200);
    expect(berlin.json<Me>().timeZone).toBe('Europe/Berlin');

    // Postgres knows it, Node does not: the planner could not format dates in it.
    const factory = await c.request('PATCH', '/v1/me', { timeZone: 'Factory' });
    expect(factory.statusCode).toBe(400);

    if (!icuOnly) return ctx.skip(); // these builds of ICU and tzdata agree
    const alias = await c.request('PATCH', '/v1/me', { timeZone: icuOnly });
    expect(alias.statusCode).toBe(400);
    expect(alias.json().error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [{ path: 'timeZone', message: 'Unknown time zone' }] },
    });
    expect((await c.request('GET', '/v1/me')).json<Me>().timeZone).toBe('Europe/Berlin');
  });

  it('the create-owner CLI rejects unknown zones and stores the canonical spelling', async () => {
    const { createOwner } = await import('../../../src/cli');
    const env = {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_APP_URL,
      SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      JARVIS_OWNER_PASSWORD: 'operator-password-123',
    };
    const email = () => `owner-${Math.random().toString(36).slice(2, 10)}@test.local`;
    for (const tz of [UNKNOWN, ...(icuOnly ? [icuOnly] : [])]) {
      await expect(
        createOwner(['--email', email(), '--name', 'Op', '--time-zone', tz], env),
      ).rejects.toThrow(/time zone/i);
    }
    const created = await createOwner(
      ['--email', email(), '--name', 'Op', '--time-zone', 'europe/berlin'],
      env,
    );
    const row = await withContext(h.db, created, (trx) =>
      trx
        .selectFrom('users')
        .select('time_zone')
        .where('id', '=', created.userId)
        .executeTakeFirstOrThrow(),
    );
    expect(row.time_zone).toBe('Europe/Berlin');
  });
});
