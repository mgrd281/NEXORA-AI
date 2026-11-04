/**
 * Phase C schema (db/migrations/0005): Row-Level Security on every new table,
 * the token-revocation outbox only SECURITY DEFINER functions reach, the
 * exactly-once keys of orders / bookings / browser sessions / email watches,
 * the purchase-spend view (security_invoker), and the job-kind split between
 * the agent worker and the browser worker.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { withContext, type DbContext, type Trx } from '../../src/db/pool';
import type { Database } from '../../src/db/types';
import { sha256 } from '../../src/lib/crypto';
import {
  BROWSER_JOB_KINDS,
  enqueue,
  heartbeat,
  lease,
  reclaimExpired,
  workerHealth,
} from '../../src/modules/jobs/queue';
import { createTestUser, testConfig, testDb, testSecrets } from './helpers';

const db = testDb();
const secrets = testSecrets(testConfig());
afterAll(() => db.destroy());

const evidenceKey = (ctx: DbContext, id: string) =>
  `tenants/${ctx.tenantId}/users/${ctx.userId}/evidence/${id}`;

/** One row in every Phase C table, owned by `ctx`. */
async function seedAll(ctx: DbContext, opts: { orderTotalMicro?: number } = {}) {
  return withContext(db, ctx, async (trx) => {
    const session = await trx
      .insertInto('sessions')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        token_hash: sha256(randomBytes(32)),
        platform: 'web',
        expires_at: new Date(Date.now() + 86_400_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const connectionId = randomUUID();
    await trx
      .insertInto('connections')
      .values({
        id: connectionId,
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        provider: 'google',
        label: 'Google',
        account_identifier: 'me@gmail.example',
        status: 'active',
        capabilities: ['mail.read', 'calendar.read'],
        granted_scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
        provider_account_id: `sub-${connectionId.slice(0, 8)}`,
        secret_ciphertext: secrets.seal(
          JSON.stringify({ accessToken: 'a', refreshToken: 'r' }),
          `oauth:${ctx.userId}:google:${connectionId}`,
        ),
        secret_key_id: secrets.keyId,
        token_expires_at: new Date(Date.now() + 3_600_000),
      })
      .execute();
    const stateId = randomUUID();
    await trx
      .insertInto('oauth_states')
      .values({
        id: stateId,
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        session_id: session.id,
        provider: 'google',
        capabilities: ['calendar.write'],
        requested_scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'],
        state_hash: sha256(randomBytes(32)),
        code_verifier_ciphertext: secrets.seal(
          'v'.repeat(43),
          `oauth-state:${ctx.userId}:${stateId}`,
        ),
        code_verifier_key_id: secrets.keyId,
        redirect_uri: 'http://localhost:3000/connections/callback',
        connection_id: connectionId,
        return_to: '/connections',
        expires_at: new Date(Date.now() + 10 * 60_000),
      })
      .execute();
    const conversation = await trx
      .insertInto('conversations')
      .values({ tenant_id: ctx.tenantId, user_id: ctx.userId, title: 'Buy headphones' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const task = await trx
      .insertInto('tasks')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        conversation_id: conversation.id,
        title: 'Buy headphones',
        request: 'buy the FX-100 headphones on the fixture shop',
        source: 'text',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const step = await trx
      .insertInto('task_steps')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: task.id,
        position: 0,
        step_key: 's1',
        title: 'Place the order',
        tool_id: 'shop.checkout',
        input: JSON.stringify({}),
        risk_level: 'HIGH',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const watch = await trx
      .insertInto('email_watches')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        connection_id: connectionId,
        provider: 'google',
        thread_id: `thread-${randomUUID().slice(0, 8)}`,
        subject: 'Quote',
        task_id: task.id,
        next_check_at: new Date(Date.now() - 1_000),
        expires_at: new Date(Date.now() + 14 * 86_400_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const session2 = await trx
      .insertInto('browser_sessions')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: task.id,
        step_id: step.id,
        status: 'succeeded',
        site_id: 'fixture-shop',
        operation: 'checkout',
        idempotency_key: step.id,
        request: JSON.stringify({ cart: 'c1' }),
        result: JSON.stringify({ orderId: 'FX-1' }),
        started_at: new Date(),
        ended_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const artifactId = randomUUID();
    await trx
      .insertInto('evidence_artifacts')
      .values({
        id: artifactId,
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: task.id,
        browser_session_id: session2.id,
        kind: 'screenshot',
        media_type: 'image/png',
        size_bytes: 2048,
        sha256: 'd'.repeat(64),
        storage_driver: 'local',
        storage_key: evidenceKey(ctx, artifactId),
        page_url: 'http://127.0.0.1:4599/shop/checkout',
      })
      .execute();
    const order = await trx
      .insertInto('orders')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: task.id,
        step_id: step.id,
        site_id: 'fixture-shop',
        merchant_name: 'Fixture Audio',
        merchant_host: '127.0.0.1:4599',
        idempotency_key: `order:${step.id}`,
        status: 'placed',
        items: JSON.stringify([
          {
            title: 'FX-100',
            quantity: 1,
            unitPrice: { amountMicro: 79_000_000, currency: 'USD' },
            lineTotal: { amountMicro: 79_000_000, currency: 'USD' },
            productUrl: 'http://127.0.0.1:4599/shop/products/fx-100',
          },
        ]),
        currency: 'USD',
        subtotal_micro: 79_000_000,
        shipping_micro: 4_990_000,
        total_micro: opts.orderTotalMicro ?? 83_990_000,
        merchant_order_id: 'FX-1',
        placed_at: new Date(),
        action_hash: 'h'.repeat(64),
        confirmation_artifact_id: artifactId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const booking = await trx
      .insertInto('bookings')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        task_id: task.id,
        step_id: step.id,
        site_id: 'fixture-booking',
        site_name: 'Fixture Dental',
        site_host: '127.0.0.1:4599',
        service: 'Check-up',
        idempotency_key: `booking:${step.id}`,
        status: 'confirmed',
        slot_start: new Date('2026-11-10T09:00:00Z'),
        slot_end: new Date('2026-11-10T09:30:00Z'),
        time_zone: 'Europe/Berlin',
        reference: 'FXD-42',
        binding: true,
        action_hash: 'h'.repeat(64),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return {
      sessionId: session.id,
      connectionId,
      stateId,
      taskId: task.id,
      stepId: step.id,
      watchId: watch.id,
      browserSessionId: session2.id,
      artifactId,
      orderId: order.id,
      bookingId: booking.id,
    };
  });
}

type Seeded = Awaited<ReturnType<typeof seedAll>>;

/** Each Phase C table with the seeded id that identifies the row. */
const TABLES: { table: keyof Database; id: (s: Seeded) => string }[] = [
  { table: 'oauth_states', id: (s) => s.stateId },
  { table: 'email_watches', id: (s) => s.watchId },
  { table: 'browser_sessions', id: (s) => s.browserSessionId },
  { table: 'evidence_artifacts', id: (s) => s.artifactId },
  { table: 'orders', id: (s) => s.orderId },
  { table: 'bookings', id: (s) => s.bookingId },
  { table: 'connections', id: (s) => s.connectionId },
];

const count = async (trx: Trx | typeof db, table: string, id: string) =>
  Number(
    (
      await sql<{
        n: string;
      }>`select count(*) as n from ${sql.table(table)} where id = ${id}`.execute(trx)
    ).rows[0]!.n,
  );

describe('Phase C tables: cross-tenant isolation (RLS)', () => {
  it('another tenant cannot read, change or delete any of the rows, even by id', async () => {
    const alice = await createTestUser(db);
    const bob = await createTestUser(db);
    const seeded = await seedAll(alice);
    for (const { table, id } of TABLES) {
      const rowId = id(seeded);
      await withContext(db, bob, async (trx) => {
        expect(await count(trx, table, rowId), `${table} read`).toBe(0);
        const upd =
          await sql`update ${sql.table(table)} set tenant_id = tenant_id where id = ${rowId}`.execute(
            trx,
          );
        expect(Number(upd.numAffectedRows), `${table} update`).toBe(0);
        const del = await sql`delete from ${sql.table(table)} where id = ${rowId}`.execute(trx);
        expect(Number(del.numAffectedRows), `${table} delete`).toBe(0);
      });
      await withContext(db, alice, async (trx) =>
        expect(await count(trx, table, rowId), `${table} owner`).toBe(1),
      );
    }
  });

  it('a user in the same tenant cannot see another user’s rows', async () => {
    const alice = await createTestUser(db);
    const carol = { tenantId: alice.tenantId, userId: randomUUID() };
    await withContext(db, alice, (trx) =>
      trx
        .insertInto('users')
        .values({
          id: carol.userId,
          tenant_id: alice.tenantId,
          email: `c-${carol.userId.slice(0, 8)}@test.local`,
          display_name: 'Carol',
          password_hash: 'x',
        })
        .execute(),
    );
    const seeded = await seedAll(alice);
    for (const { table, id } of TABLES)
      await withContext(db, carol, async (trx) =>
        expect(await count(trx, table, id(seeded)), table).toBe(0),
      );
  });

  it('without a context no Phase C row is visible', async () => {
    const alice = await createTestUser(db);
    const seeded = await seedAll(alice);
    for (const { table, id } of TABLES) expect(await count(db, table, id(seeded)), table).toBe(0);
  });

  it('no row can be written into another tenant', async () => {
    const alice = await createTestUser(db);
    const bob = await createTestUser(db);
    const seeded = await seedAll(alice);
    await expect(
      withContext(db, bob, (trx) =>
        trx
          .insertInto('orders')
          .values({
            tenant_id: alice.tenantId,
            user_id: alice.userId,
            site_id: 'fixture-shop',
            merchant_name: 'X',
            merchant_host: 'x',
            idempotency_key: `order:${randomUUID()}`,
            items: JSON.stringify([{}]),
            currency: 'USD',
            subtotal_micro: 1,
            shipping_micro: 0,
            total_micro: 1,
            action_hash: 'h'.repeat(64),
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withContext(db, bob, (trx) =>
        trx
          .insertInto('email_watches')
          .values({
            tenant_id: alice.tenantId,
            user_id: alice.userId,
            connection_id: seeded.connectionId,
            provider: 'google',
            thread_id: 't',
            subject: 's',
            next_check_at: new Date(),
            expires_at: new Date(Date.now() + 86_400_000),
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('the purchase-spend view applies the caller’s own RLS (security_invoker)', async () => {
    const alice = await createTestUser(db);
    const bob = await createTestUser(db);
    await seedAll(alice, { orderTotalMicro: 50_000_000 });
    const sum = (trx: Trx) =>
      trx
        .selectFrom('committed_purchases')
        .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('total_micro'), sql<number>`0`).as('t'))
        .executeTakeFirstOrThrow();
    expect(Number((await withContext(db, alice, sum)).t)).toBe(50_000_000);
    expect(Number((await withContext(db, bob, sum)).t)).toBe(0);
    expect(Number((await db.selectFrom('committed_purchases').selectAll().execute()).length)).toBe(
      0,
    );
  });
});

describe('committed purchases (0006): paid bookings count, per step', () => {
  it('counts paid bookings in flight, confirmed or unknown — never free, failed or another user’s', async () => {
    const alice = await createTestUser(db);
    const bob = await createTestUser(db);
    const seeded = await seedAll(alice, { orderTotalMicro: 10_000_000 });
    const paid = (
      status: 'submitting' | 'confirmed' | 'failed' | 'unknown',
      price: number | null,
    ) =>
      withContext(db, alice, async (trx) => {
        const step = await trx
          .selectFrom('task_steps')
          .select(['id', 'task_id'])
          .where('task_id', '=', seeded.taskId)
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('bookings')
          .values({
            tenant_id: alice.tenantId,
            user_id: alice.userId,
            task_id: step.task_id,
            step_id: step.id,
            site_id: 'fixture-booking',
            site_name: 'Fixture Dental',
            site_host: '127.0.0.1:4599',
            service: 'Dental cleaning',
            idempotency_key: `booking:${randomUUID()}`,
            status,
            slot_start: new Date('2026-11-10T09:00:00Z'),
            time_zone: 'Europe/Berlin',
            reference: status === 'confirmed' ? 'FXD-7' : null,
            failure_reason: status === 'failed' || status === 'unknown' ? 'SLOT_TAKEN' : null,
            price_micro: price,
            price_currency: price === null ? null : 'USD',
            binding: true,
            action_hash: 'b'.repeat(64),
          })
          .execute();
      });
    await paid('confirmed', 80_000_000);
    await paid('unknown', 5_000_000);
    await paid('failed', 70_000_000);
    await paid('confirmed', null);
    const rows = await withContext(db, alice, (trx) =>
      trx.selectFrom('committed_purchases').select(['kind', 'total_micro', 'step_id']).execute(),
    );
    expect(
      rows
        .filter((r) => r.kind === 'booking')
        .map((r) => Number(r.total_micro))
        .sort(),
    ).toEqual([5_000_000, 80_000_000]);
    expect(rows.filter((r) => r.kind === 'order')).toHaveLength(1);
    expect(rows.every((r) => r.step_id !== null)).toBe(true);
    const sum = (trx: Trx) =>
      trx
        .selectFrom('committed_purchases')
        .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('total_micro'), sql<number>`0`).as('t'))
        .executeTakeFirstOrThrow();
    expect(Number((await withContext(db, alice, sum)).t)).toBe(95_000_000);
    expect(Number((await withContext(db, bob, sum)).t)).toBe(0);
  });
});

describe('OAuth tokens and authorization requests', () => {
  it('the application role cannot touch the revocation outbox directly', async () => {
    await expect(sql`select * from oauth_revocations`.execute(db)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('disconnecting Google queues its tokens for revocation once; Microsoft has nothing to revoke', async () => {
    const alice = await createTestUser(db);
    const seeded = await seedAll(alice);
    const msId = randomUUID();
    await withContext(db, alice, async (trx) => {
      await trx
        .insertInto('connections')
        .values({
          id: msId,
          tenant_id: alice.tenantId,
          user_id: alice.userId,
          provider: 'microsoft',
          label: 'Microsoft',
          status: 'active',
          capabilities: ['calendar.read'],
          provider_account_id: 'oid-1',
          secret_ciphertext: Buffer.from('sealed'),
          secret_key_id: 'k1',
        })
        .execute();
      await trx.deleteFrom('connections').where('id', 'in', [seeded.connectionId, msId]).execute();
    });
    const claimed = await sql<{
      id: string;
      provider: string;
      connection_id: string;
      user_id: string;
      attempts: number;
    }>`select * from oauth_revocations_claim(100, 60)`.execute(db);
    const mine = claimed.rows.filter((r) => r.user_id === alice.userId);
    expect(mine.map((r) => [r.provider, r.connection_id])).toEqual([
      ['google', seeded.connectionId],
    ]);
    expect(mine[0]!.attempts).toBe(1);
    // The watches of the account went with it.
    await withContext(db, alice, async (trx) =>
      expect(await count(trx, 'email_watches', seeded.watchId)).toBe(0),
    );
    const done = await sql<{
      n: number;
    }>`select oauth_revocations_complete(${sql.val(claimed.rows.map((r) => r.id))}::bigint[]) as n`.execute(
      db,
    );
    expect(done.rows[0]!.n).toBe(claimed.rows.length);
  });

  it('an authorization request dies with the session that started it', async () => {
    const alice = await createTestUser(db);
    const seeded = await seedAll(alice);
    await withContext(db, alice, (trx) =>
      trx.deleteFrom('sessions').where('id', '=', seeded.sessionId).execute(),
    );
    await withContext(db, alice, async (trx) =>
      expect(await count(trx, 'oauth_states', seeded.stateId)).toBe(0),
    );
  });

  it('authorization requests are short-lived', async () => {
    const alice = await createTestUser(db);
    const seeded = await seedAll(alice);
    await expect(
      withContext(db, alice, (trx) =>
        trx
          .updateTable('oauth_states')
          .set({ expires_at: new Date(Date.now() + 60 * 60_000) })
          .where('id', '=', seeded.stateId)
          .execute(),
      ),
    ).rejects.toThrow(/oauth_states_short_lived/);
    const purged = await sql<{ n: number }>`select oauth_states_purge() as n`.execute(db);
    expect(purged.rows[0]!.n).toBeGreaterThanOrEqual(0);
  });

  it('an active OAuth connection always has its tokens and account; SMTP has no capabilities', async () => {
    const alice = await createTestUser(db);
    await expect(
      withContext(db, alice, (trx) =>
        trx
          .insertInto('connections')
          .values({
            tenant_id: alice.tenantId,
            user_id: alice.userId,
            provider: 'google',
            label: 'Google',
            status: 'active',
          })
          .execute(),
      ),
    ).rejects.toThrow(/connections_oauth_active/);
    await expect(
      withContext(db, alice, (trx) =>
        trx
          .insertInto('connections')
          .values({
            tenant_id: alice.tenantId,
            user_id: alice.userId,
            provider: 'smtp',
            label: 'Email',
            status: 'active',
            capabilities: ['mail.send'],
          })
          .execute(),
      ),
    ).rejects.toThrow(/connections_oauth_fields/);
  });
});

describe('exactly-once records', () => {
  it('one order per idempotency key, and a placed order names the merchant’s order', async () => {
    const alice = await createTestUser(db);
    const seeded = await seedAll(alice);
    const again = (status: 'submitting' | 'placed', key: string) =>
      withContext(db, alice, (trx) =>
        trx
          .insertInto('orders')
          .values({
            tenant_id: alice.tenantId,
            user_id: alice.userId,
            site_id: 'fixture-shop',
            merchant_name: 'Fixture Audio',
            merchant_host: '127.0.0.1:4599',
            idempotency_key: key,
            status,
            items: JSON.stringify([{}]),
            currency: 'USD',
            subtotal_micro: 1,
            shipping_micro: 0,
            total_micro: 1,
            action_hash: 'h'.repeat(64),
          })
          .execute(),
      );
    await expect(again('submitting', `order:${seeded.stepId}`)).rejects.toThrow(
      /orders_once_per_key/,
    );
    await expect(again('placed', `order:${randomUUID()}`)).rejects.toThrow(/orders_placed/);
  });

  it('one browser session per execution key and one live watch per thread', async () => {
    const alice = await createTestUser(db);
    const seeded = await seedAll(alice);
    await expect(
      withContext(db, alice, (trx) =>
        trx
          .insertInto('browser_sessions')
          .values({
            tenant_id: alice.tenantId,
            user_id: alice.userId,
            task_id: seeded.taskId,
            step_id: seeded.stepId,
            status: 'queued',
            site_id: 'fixture-shop',
            operation: 'checkout',
            idempotency_key: seeded.stepId,
            request: JSON.stringify({}),
          })
          .execute(),
      ),
    ).rejects.toThrow(/browser_sessions_once_per_key/);
    // A handover always says why and where the user continues.
    await expect(
      withContext(db, alice, (trx) =>
        trx
          .updateTable('browser_sessions')
          .set({ status: 'handover', stop_reason: 'CAPTCHA_DETECTED' })
          .where('id', '=', seeded.browserSessionId)
          .execute(),
      ),
    ).rejects.toThrow(/browser_sessions_handover/);
  });

  it('deleting a task removes its sessions and queues their evidence files for deletion', async () => {
    const alice = await createTestUser(db);
    const seeded = await seedAll(alice);
    await withContext(db, alice, (trx) =>
      trx.deleteFrom('tasks').where('id', '=', seeded.taskId).execute(),
    );
    await withContext(db, alice, async (trx) => {
      expect(await count(trx, 'browser_sessions', seeded.browserSessionId)).toBe(0);
      expect(await count(trx, 'evidence_artifacts', seeded.artifactId)).toBe(0);
      // Orders and bookings stay (financial / appointment records), without the task.
      const order = await trx
        .selectFrom('orders')
        .select(['task_id', 'confirmation_artifact_id'])
        .where('id', '=', seeded.orderId)
        .executeTakeFirstOrThrow();
      expect(order).toEqual({ task_id: null, confirmation_artifact_id: null });
    });
    const claimed = await sql<{
      id: string;
      storage_key: string;
    }>`select * from storage_deletions_claim(500, 60)`.execute(db);
    expect(
      claimed.rows.filter((r) => r.storage_key === evidenceKey(alice, seeded.artifactId)),
    ).toHaveLength(1);
    await sql`select storage_deletions_complete(${sql.val(claimed.rows.map((r) => r.id))}::bigint[])`.execute(
      db,
    );
  });

  it('due watches are found across tenants, ids only', async () => {
    const alice = await createTestUser(db);
    const seeded = await seedAll(alice);
    const due = await sql<{
      watch_id: string;
      user_id: string;
    }>`select * from email_watches_due(500)`.execute(db);
    expect(due.rows.find((r) => r.watch_id === seeded.watchId)?.user_id).toBe(alice.userId);
    expect(Object.keys(due.rows[0]!).sort()).toEqual(
      ['next_check_at', 'tenant_id', 'user_id', 'watch_id'].sort(),
    );
  });
});

describe('job kinds: agent worker vs browser worker', () => {
  it('each worker leases and reclaims only its own kinds', async () => {
    const alice = await createTestUser(db);
    const key = randomUUID();
    await withContext(db, alice, async (trx) => {
      await enqueue(trx, {
        kind: 'browser.session',
        tenantId: alice.tenantId,
        userId: alice.userId,
        payload: { sessionId: key },
        dedupeKey: `browser:${key}`,
      });
      await enqueue(trx, {
        kind: 'email.watch_poll',
        tenantId: alice.tenantId,
        userId: alice.userId,
        payload: { watchId: key },
        dedupeKey: `email-watch:${key}`,
      });
    });
    const agentJobs = await lease(db, `agent-${key}`, 60_000, 100, { except: BROWSER_JOB_KINDS });
    expect(agentJobs.some((j) => j.kind === 'browser.session')).toBe(false);
    expect(agentJobs.some((j) => j.dedupe_key === `email-watch:${key}`)).toBe(true);
    const browserJobs = await lease(db, `browser-${key}`, 1, 100, { only: BROWSER_JOB_KINDS });
    expect(browserJobs.every((j) => j.kind === 'browser.session')).toBe(true);
    expect(browserJobs.some((j) => j.dedupe_key === `browser:${key}`)).toBe(true);
    // The browser lease (1 ms) expires; only a browser-kind reclaim returns it to the queue.
    await new Promise((r) => setTimeout(r, 20));
    const agentReclaim = await reclaimExpired(db, { except: BROWSER_JOB_KINDS });
    expect(agentReclaim.dead.some((j) => j.dedupe_key === `browser:${key}`)).toBe(false);
    const browserReclaim = await reclaimExpired(db, { only: BROWSER_JOB_KINDS });
    expect(browserReclaim.requeued).toBeGreaterThanOrEqual(1);
    await db.deleteFrom('jobs').where('user_id', '=', alice.userId).execute();
  });

  it('agent and browser workers report health separately', async () => {
    const id = `browser-${randomUUID()}`;
    await heartbeat(db, id, 'test', '0.0.0', 'browser');
    expect((await workerHealth(db, 'browser')).healthy).toBe(true);
    const row = await db
      .selectFrom('worker_heartbeats')
      .select('kind')
      .where('worker_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.kind).toBe('browser');
    await db.deleteFrom('worker_heartbeats').where('worker_id', '=', id).execute();
  });
});
