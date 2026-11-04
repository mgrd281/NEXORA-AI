/**
 * Phase B schema (db/migrations/0004): Row-Level Security on every new table,
 * the storage-deletion outbox that only SECURITY DEFINER functions reach, and
 * the database invariants the runtime relies on for exactly-once behaviour.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { withContext, type DbContext, type Trx } from '../../src/db/pool';
import type { Database } from '../../src/db/types';
import { createTestUser, testDb, testSecrets, testConfig } from './helpers';

const db = testDb();
const secrets = testSecrets(testConfig());
afterAll(() => db.destroy());

const storageKey = (ctx: DbContext, id: string) =>
  `tenants/${ctx.tenantId}/users/${ctx.userId}/attachments/${id}`;

/** One row in every Phase B table, owned by `ctx`. */
async function seedAll(ctx: DbContext) {
  return withContext(db, ctx, async (trx) => {
    const conversation = await trx
      .insertInto('conversations')
      .values({ tenant_id: ctx.tenantId, user_id: ctx.userId, title: 'Private thread' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const task = await trx
      .insertInto('tasks')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        conversation_id: conversation.id,
        title: 'Summarize the contract',
        request: 'summarize the attached contract',
        source: 'text',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const attachmentId = randomUUID();
    await trx
      .insertInto('attachments')
      .values({
        id: attachmentId,
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        conversation_id: conversation.id,
        filename: 'contract.pdf',
        media_type: 'application/pdf',
        size_bytes: 1234,
        sha256: 'b'.repeat(64),
        storage_driver: 'local',
        storage_key: storageKey(ctx, attachmentId),
      })
      .execute();
    await trx
      .insertInto('task_attachments')
      .values({
        task_id: task.id,
        attachment_id: attachmentId,
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        position: 0,
      })
      .execute();
    const schedule = await trx
      .insertInto('scheduled_tasks')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        title: 'Weekly digest',
        request: 'summarize https://example.com and email it to me',
        rrule: 'DTSTART;TZID=Europe/Berlin:20261109T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO',
        time_zone: 'Europe/Berlin',
        recurrence: JSON.stringify({
          frequency: 'weekly',
          interval: 1,
          byWeekday: ['MO'],
          time: '09:00',
          timeZone: 'Europe/Berlin',
        }),
        // Due already, so the scheduler look-up below finds it.
        next_run_at: new Date(Date.now() - 60_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const run = await trx
      .insertInto('schedule_runs')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        schedule_id: schedule.id,
        occurrence_at: new Date('2026-11-02T08:00:00Z'),
        status: 'created',
        task_id: task.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const endpointId = randomUUID();
    await trx
      .insertInto('webhook_endpoints')
      .values({
        id: endpointId,
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        url: 'https://hooks.example.com/jarvis',
        event_types: ['task.completed'],
        secret_ciphertext: secrets.seal('whsec_test', `webhook:${ctx.userId}:${endpointId}`),
        secret_key_id: secrets.keyId,
        secret_hint: 'whsec_…test',
      })
      .execute();
    const delivery = await trx
      .insertInto('webhook_deliveries')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        endpoint_id: endpointId,
        event_type: 'task.completed',
        event_key: `task.completed:${task.id}`,
        payload: JSON.stringify({
          type: 'task.completed',
          timestamp: new Date().toISOString(),
          data: { taskId: task.id },
        }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return {
      conversationId: conversation.id,
      taskId: task.id,
      attachmentId,
      scheduleId: schedule.id,
      runId: run.id,
      endpointId,
      deliveryId: delivery.id,
    };
  });
}

type Seeded = Awaited<ReturnType<typeof seedAll>>;

/** Each Phase B table with the column and seeded id that identify the row. */
const TABLES: { table: keyof Database; column: string; id: (s: Seeded) => string }[] = [
  { table: 'attachments', column: 'id', id: (s) => s.attachmentId },
  { table: 'task_attachments', column: 'attachment_id', id: (s) => s.attachmentId },
  { table: 'scheduled_tasks', column: 'id', id: (s) => s.scheduleId },
  { table: 'schedule_runs', column: 'id', id: (s) => s.runId },
  { table: 'webhook_endpoints', column: 'id', id: (s) => s.endpointId },
  { table: 'webhook_deliveries', column: 'id', id: (s) => s.deliveryId },
];

const count = async (trx: Trx, table: string, column: string, id: string) =>
  Number(
    (
      await sql<{
        n: string;
      }>`select count(*) as n from ${sql.table(table)} where ${sql.ref(column)} = ${id}`.execute(
        trx,
      )
    ).rows[0]!.n,
  );

describe('Phase B tables: cross-tenant isolation (RLS)', () => {
  it('another tenant cannot read, change or delete any of the rows, even by id', async () => {
    const alice = await createTestUser(db);
    const bob = await createTestUser(db);
    const seeded = await seedAll(alice);
    for (const { table, column, id } of TABLES) {
      const rowId = id(seeded);
      await withContext(db, bob, async (trx) => {
        expect(await count(trx, table, column, rowId), `${table} read`).toBe(0);
        const upd =
          await sql`update ${sql.table(table)} set created_at = now() where ${sql.ref(column)} = ${rowId}`.execute(
            trx,
          );
        expect(Number(upd.numAffectedRows), `${table} update`).toBe(0);
        const del =
          await sql`delete from ${sql.table(table)} where ${sql.ref(column)} = ${rowId}`.execute(
            trx,
          );
        expect(Number(del.numAffectedRows), `${table} delete`).toBe(0);
      });
      await withContext(db, alice, async (trx) =>
        expect(await count(trx, table, column, rowId), `${table} owner`).toBe(1),
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
    for (const { table, column, id } of TABLES)
      await withContext(db, carol, async (trx) =>
        expect(await count(trx, table, column, id(seeded)), table).toBe(0),
      );
  });

  it('no row can be written into another tenant', async () => {
    const alice = await createTestUser(db);
    const bob = await createTestUser(db);
    const seeded = await seedAll(alice);
    await expect(
      withContext(db, bob, (trx) =>
        trx
          .insertInto('webhook_endpoints')
          .values({
            tenant_id: alice.tenantId,
            user_id: alice.userId,
            url: 'https://evil.example/hook',
            event_types: ['task.completed'],
            secret_ciphertext: Buffer.from('x'),
            secret_key_id: 'k1',
            secret_hint: 'x',
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    // Nor can Bob link files to her task.
    await expect(
      withContext(db, bob, (trx) =>
        trx
          .insertInto('task_attachments')
          .values({
            task_id: seeded.taskId,
            attachment_id: seeded.attachmentId,
            tenant_id: alice.tenantId,
            user_id: alice.userId,
            position: 1,
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('without a context no Phase B row is visible', async () => {
    const alice = await createTestUser(db);
    const seeded = await seedAll(alice);
    for (const { table, column, id } of TABLES) {
      const r = await sql<{
        n: string;
      }>`select count(*) as n from ${sql.table(table)} where ${sql.ref(column)} = ${id(seeded)}`.execute(
        db,
      );
      expect(Number(r.rows[0]!.n), table).toBe(0);
    }
  });
});

describe('storage deletions (definer-only outbox)', () => {
  it('the application role cannot touch the table directly', async () => {
    await expect(sql`select * from storage_deletions`.execute(db)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      sql`insert into storage_deletions (storage_driver, storage_key, tenant_id) values ('local', 'x', ${randomUUID()})`.execute(
        db,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('deleting an account queues its stored objects for deletion, once each', async () => {
    const alice = await createTestUser(db);
    const seeded = await seedAll(alice);
    const key = storageKey(alice, seeded.attachmentId);
    await withContext(db, alice, (trx) =>
      trx.deleteFrom('users').where('id', '=', alice.userId).execute(),
    );
    // Drain everything that is due and look for this key (other files may be queued too).
    const claimed = await sql<{
      id: string;
      storage_key: string;
      attempts: number;
    }>`select * from storage_deletions_claim(500, 60)`.execute(db);
    const mine = claimed.rows.filter((r) => r.storage_key === key);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.attempts).toBe(1);
    // Leased: not handed out again until the lease ends.
    const again = await sql<{
      storage_key: string;
    }>`select * from storage_deletions_claim(500, 60)`.execute(db);
    expect(again.rows.some((r) => r.storage_key === key)).toBe(false);
    const done = await sql<{
      n: number;
    }>`select storage_deletions_complete(${sql.val(claimed.rows.map((r) => r.id))}::bigint[]) as n`.execute(
      db,
    );
    expect(done.rows[0]!.n).toBe(claimed.rows.length);
  });
});

describe('Phase B invariants', () => {
  it('storage keys carry the owner’s tenant and user prefix', async () => {
    const alice = await createTestUser(db);
    const bob = await createTestUser(db);
    const id = randomUUID();
    await expect(
      withContext(db, alice, (trx) =>
        trx
          .insertInto('attachments')
          .values({
            id,
            tenant_id: alice.tenantId,
            user_id: alice.userId,
            filename: 'a.txt',
            media_type: 'text/plain',
            size_bytes: 1,
            sha256: 'c'.repeat(64),
            storage_driver: 'local',
            storage_key: storageKey(bob, id),
            expires_at: new Date(Date.now() + 86_400_000),
          })
          .execute(),
      ),
    ).rejects.toThrow(/attachments_storage_key_format/);
  });

  it('JARVIS writes at most one message per task, and a question needs the question outcome', async () => {
    const alice = await createTestUser(db);
    const seeded = await seedAll(alice);
    await withContext(db, alice, async (trx) => {
      const msg = {
        tenant_id: alice.tenantId,
        user_id: alice.userId,
        conversation_id: seeded.conversationId,
        task_id: seeded.taskId,
        role: 'assistant' as const,
        kind: 'answer' as const,
        content: 'The contract runs for two years.',
      };
      await trx.insertInto('messages').values(msg).execute();
      const second = await trx
        .insertInto('messages')
        .values(msg)
        // The arbiter of a partial unique index needs its predicate as literal SQL
        // (a bound parameter cannot prove it implies the index predicate).
        .onConflict((oc) =>
          oc
            .column('task_id')
            .where(sql<boolean>`role = 'assistant' AND task_id IS NOT NULL`)
            .doNothing(),
        )
        .returning('id')
        .execute();
      expect(second).toHaveLength(0);
    });
    await expect(
      withContext(db, alice, (trx) =>
        trx
          .insertInto('messages')
          .values({
            tenant_id: alice.tenantId,
            user_id: alice.userId,
            conversation_id: seeded.conversationId,
            role: 'user',
            kind: 'answer',
            content: 'x',
          })
          .execute(),
      ),
    ).rejects.toThrow(/messages_kind_role/);
    await expect(
      withContext(db, alice, (trx) =>
        trx
          .updateTable('tasks')
          .set({ outcome: 'answer' })
          .where('id', '=', seeded.taskId)
          .execute(),
      ),
    ).rejects.toThrow(/tasks_outcome_completed/);
    await expect(
      withContext(db, alice, (trx) =>
        trx
          .updateTable('tasks')
          .set({
            status: 'COMPLETED',
            outcome: 'question',
          })
          .where('id', '=', seeded.taskId)
          .execute(),
      ),
    ).rejects.toThrow(/tasks_question_outcome/);
  });

  it('each schedule occurrence runs at most once, and each event is delivered once per endpoint', async () => {
    const alice = await createTestUser(db);
    const seeded = await seedAll(alice);
    await expect(
      withContext(db, alice, (trx) =>
        trx
          .insertInto('schedule_runs')
          .values({
            tenant_id: alice.tenantId,
            user_id: alice.userId,
            schedule_id: seeded.scheduleId,
            occurrence_at: new Date('2026-11-02T08:00:00Z'),
            status: 'created',
          })
          .execute(),
      ),
    ).rejects.toThrow(/schedule_runs_once_per_occurrence/);
    await expect(
      withContext(db, alice, (trx) =>
        trx
          .insertInto('webhook_deliveries')
          .values({
            tenant_id: alice.tenantId,
            user_id: alice.userId,
            endpoint_id: seeded.endpointId,
            event_type: 'task.completed',
            event_key: `task.completed:${seeded.taskId}`,
            payload: JSON.stringify({ type: 'task.completed', timestamp: 'x', data: {} }),
          })
          .execute(),
      ),
    ).rejects.toThrow(/webhook_deliveries_once_per_event/);
  });

  it('a schedule is enabled exactly while active, and only an active one has a next run', async () => {
    const alice = await createTestUser(db);
    const seeded = await seedAll(alice);
    await withContext(db, alice, async (trx) => {
      const active = await trx
        .selectFrom('scheduled_tasks')
        .select('enabled')
        .where('id', '=', seeded.scheduleId)
        .executeTakeFirstOrThrow();
      expect(active.enabled).toBe(true);
      await trx
        .updateTable('scheduled_tasks')
        .set({ status: 'paused', paused_reason: 'user', next_run_at: null })
        .where('id', '=', seeded.scheduleId)
        .execute();
      const paused = await trx
        .selectFrom('scheduled_tasks')
        .select('enabled')
        .where('id', '=', seeded.scheduleId)
        .executeTakeFirstOrThrow();
      expect(paused.enabled).toBe(false);
    });
    await expect(
      withContext(db, alice, (trx) =>
        trx
          .updateTable('scheduled_tasks')
          .set({ status: 'active', paused_reason: null })
          .where('id', '=', seeded.scheduleId)
          .execute(),
      ),
    ).rejects.toThrow(/scheduled_tasks_next_run/);
  });

  it('the scheduler and retention look-ups return only ids, across tenants', async () => {
    const alice = await createTestUser(db, {
      preferences: { retention: { memoryDays: 30, taskHistoryDays: null } },
    });
    const seeded = await seedAll(alice);
    const due = await sql<{
      schedule_id: string;
      tenant_id: string;
      user_id: string;
    }>`select * from scheduler_due_schedules(500)`.execute(db);
    expect(due.rows.some((r) => r.schedule_id === seeded.scheduleId)).toBe(true);
    expect(Object.keys(due.rows[0]!).sort()).toEqual(
      ['next_run_at', 'schedule_id', 'tenant_id', 'user_id'].sort(),
    );
    const users = await sql<{
      user_id: string;
    }>`select * from retention_due_users(null, 1000)`.execute(db);
    expect(users.rows.some((r) => r.user_id === alice.userId)).toBe(true);
  });

  it('accepts the Phase B notification and job kinds', async () => {
    const alice = await createTestUser(db);
    await withContext(db, alice, (trx) =>
      trx
        .insertInto('notifications')
        .values(
          (['schedule_failed', 'schedule_paused', 'webhook_disabled'] as const).map((kind) => ({
            tenant_id: alice.tenantId,
            user_id: alice.userId,
            kind,
            data: JSON.stringify({}),
          })),
        )
        .execute(),
    );
    const jobs = await db
      .insertInto('jobs')
      .values(
        (['schedule.run', 'retention.sweep', 'webhook.deliver'] as const).map((kind) => ({
          kind,
          tenant_id: alice.tenantId,
          user_id: alice.userId,
          run_at: new Date(Date.now() + 3_600_000),
        })),
      )
      .returning('id')
      .execute();
    expect(jobs).toHaveLength(3);
    await db
      .deleteFrom('jobs')
      .where(
        'id',
        'in',
        jobs.map((j) => j.id),
      )
      .execute();
  });
});
