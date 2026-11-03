import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { withContext } from '../../src/db/pool';
import { createTestUser, testDb } from './helpers';

const db = testDb();
afterAll(() => db.destroy());

async function seedTask(ctx: { tenantId: string; userId: string }) {
  return withContext(db, ctx, async (trx) => {
    const conv = await trx
      .insertInto('conversations')
      .values({ tenant_id: ctx.tenantId, user_id: ctx.userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    return trx
      .insertInto('tasks')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        conversation_id: conv.id,
        title: 'Secret plan',
        request: 'do something private',
        source: 'text',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  });
}

describe('cross-tenant isolation (Row-Level Security)', () => {
  it('a user cannot read another tenant’s tasks, even by id', async () => {
    const alice = await createTestUser(db);
    const bob = await createTestUser(db);
    const task = await seedTask(alice);
    const seenByBob = await withContext(db, bob, (trx) =>
      trx.selectFrom('tasks').selectAll().where('id', '=', task.id).execute(),
    );
    expect(seenByBob).toHaveLength(0);
    const seenByAlice = await withContext(db, alice, (trx) =>
      trx.selectFrom('tasks').selectAll().where('id', '=', task.id).execute(),
    );
    expect(seenByAlice).toHaveLength(1);
  });

  it('a user cannot update or delete another tenant’s rows', async () => {
    const alice = await createTestUser(db);
    const bob = await createTestUser(db);
    const task = await seedTask(alice);
    const upd = await withContext(db, bob, (trx) =>
      trx.updateTable('tasks').set({ title: 'pwned' }).where('id', '=', task.id).executeTakeFirst(),
    );
    expect(Number(upd.numUpdatedRows)).toBe(0);
    const del = await withContext(db, bob, (trx) =>
      trx.deleteFrom('tasks').where('id', '=', task.id).executeTakeFirst(),
    );
    expect(Number(del.numDeletedRows)).toBe(0);
    const still = await withContext(db, alice, (trx) =>
      trx.selectFrom('tasks').select('title').where('id', '=', task.id).executeTakeFirstOrThrow(),
    );
    expect(still.title).toBe('Secret plan');
  });

  it('a user cannot insert rows into another tenant', async () => {
    const alice = await createTestUser(db);
    const bob = await createTestUser(db);
    await expect(
      withContext(db, bob, (trx) =>
        trx
          .insertInto('memories')
          .values({
            tenant_id: alice.tenantId,
            user_id: alice.userId,
            kind: 'fact',
            content: 'x',
            source: 'user',
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('users in the same tenant cannot see each other’s private rows', async () => {
    const alice = await createTestUser(db);
    const carolId = randomUUID();
    await withContext(db, alice, (trx) =>
      trx
        .insertInto('users')
        .values({
          id: carolId,
          tenant_id: alice.tenantId,
          email: `c-${carolId.slice(0, 6)}@test.local`,
          display_name: 'Carol',
          password_hash: 'x',
        })
        .execute(),
    );
    const task = await seedTask(alice);
    const seenByCarol = await withContext(
      db,
      { tenantId: alice.tenantId, userId: carolId },
      (trx) => trx.selectFrom('tasks').selectAll().where('id', '=', task.id).execute(),
    );
    expect(seenByCarol).toHaveLength(0);
  });

  it('without a context no tenant data is visible', async () => {
    const alice = await createTestUser(db);
    await seedTask(alice);
    const rows = await db.selectFrom('tasks').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('the audit log is append-only for the application role', async () => {
    await expect(sql`select * from audit_events`.execute(db)).rejects.toThrow(/permission denied/);
    await expect(sql`delete from audit_events`.execute(db)).rejects.toThrow(/permission denied/);
  });
});
