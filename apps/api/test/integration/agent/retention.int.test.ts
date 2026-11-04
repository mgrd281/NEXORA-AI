/**
 * Retention end to end: the sweep deletes only the expired rows of the user it
 * runs for (RLS), keeps active tasks and everything newer than the cutoff,
 * cascades a finished task's history and its emptied conversation (files
 * included: the trigger queues the stored object, the drain deletes it),
 * removes expired unattached uploads and old webhook deliveries, and audits
 * counts only. The worker clock is moved forward instead of backdating rows.
 */
import { DEFAULT_PREFERENCES } from '@jarvis/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext, type DbContext } from '../../../src/db/pool';
import {
  drainStorageDeletions,
  enqueueRetentionSweeps,
  sweepUser,
} from '../../../src/modules/agent/jobs/retention';
import { StorageNotFoundError } from '../../../src/modules/storage/types';
import { makePdf } from '../../fixtures/documents';
import {
  asOwner,
  auditMetadata,
  createHarness,
  drain,
  newUser,
  storeAttachment,
  type Harness,
} from './harness';

const DAY = 86_400_000;
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  // Leave no due jobs (the queued tasks of the first test) for other suites' workers.
  await drain(h.worker);
  await h.close();
});

const retention = { memoryDays: 30 as const, taskHistoryDays: 90 as const };

async function seed(user: DbContext & { email: string }) {
  const now = Date.now();
  // Memories: one last updated now, one 80 days "later" (newer than the 30-day cutoff below).
  await withContext(h.db, user, (trx) =>
    trx
      .insertInto('memories')
      .values([
        {
          tenant_id: user.tenantId,
          user_id: user.userId,
          kind: 'fact',
          content: 'Old note.',
          source: 'user',
        },
        {
          tenant_id: user.tenantId,
          user_id: user.userId,
          kind: 'fact',
          content: 'Recent note.',
          source: 'user',
          created_at: new Date(now + 80 * DAY),
          updated_at: new Date(now + 80 * DAY),
        },
      ])
      .execute(),
  );
  // An old finished task with a file, a recent finished task, and an old active one.
  const file = await storeAttachment(h, user, {
    filename: 'old.pdf',
    mediaType: 'application/pdf',
    body: makePdf([['An old quarterly report that nobody needs any more.']]),
  });
  const old = await h.services.tasks.create(
    user,
    { request: 'summarize this', source: 'text', attachmentIds: [file] },
    {},
  );
  // Finished (FAILED: the offline planner cannot do it) and newer than the cutoff.
  const recent = await h.services.tasks.create(
    user,
    { request: 'tell me a joke', source: 'text' },
    {},
  );
  await drain(h.worker);
  await withContext(h.db, user, (trx) =>
    trx
      .updateTable('tasks')
      .set({ created_at: new Date(now + 95 * DAY) })
      .where('id', '=', recent.id)
      .execute(),
  );
  // An expired unattached upload, and an old webhook delivery.
  const upload = await storeAttachment(h, user, {
    filename: 'unused.pdf',
    mediaType: 'application/pdf',
    body: makePdf([['Uploaded but never used in any request at all.']]),
  });
  const endpoint = await withContext(h.db, user, (trx) =>
    trx
      .insertInto('webhook_endpoints')
      .values({
        tenant_id: user.tenantId,
        user_id: user.userId,
        url: 'https://hooks.jarvis.invalid/jarvis',
        event_types: ['task.completed'],
        secret_ciphertext: Buffer.from([1]),
        secret_key_id: 'k1',
        secret_hint: 'whsec_…abcd',
      })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  await withContext(h.db, user, (trx) =>
    trx
      .insertInto('webhook_deliveries')
      .values({
        tenant_id: user.tenantId,
        user_id: user.userId,
        endpoint_id: endpoint.id,
        event_type: 'task.completed',
        event_key: `task.completed:${old.id}:1`,
        payload: JSON.stringify({
          type: 'task.completed',
          timestamp: new Date().toISOString(),
          data: {},
        }),
        status: 'succeeded',
        completed_at: new Date(),
      })
      .execute(),
  );
  return { file, old: old.id, recent: recent.id, upload };
}

/** A task that is still active (queued: no job runs after this). */
async function activeTask(user: DbContext) {
  const t = await h.services.tasks.create(
    user,
    { request: 'remember that this stays queued', source: 'text' },
    {},
  );
  return t.id;
}

async function counts(user: DbContext) {
  return withContext(h.db, user, async (trx) => ({
    memories: (await trx.selectFrom('memories').select('content').orderBy('content').execute()).map(
      (m) => m.content,
    ),
    tasks: (await trx.selectFrom('tasks').select('id').execute()).map((t) => t.id).sort(),
    attachments: (await trx.selectFrom('attachments').select('id').execute())
      .map((a) => a.id)
      .sort(),
    deliveries: (await trx.selectFrom('webhook_deliveries').select('id').execute()).length,
    conversations: (await trx.selectFrom('conversations').select('id').execute()).length,
    messages: (await trx.selectFrom('messages').select('task_id').execute()).map((m) => m.task_id),
  }));
}

describe('retention sweep', () => {
  it('deletes only expired rows of the user it runs for, with their files', async () => {
    const alice = await newUser(h.db, { retention });
    const bob = await newUser(h.db, { retention });
    const carol = await newUser(h.db); // no retention: keep everything
    const a = await seed(alice);
    const b = await seed(bob);
    await seed(carol);
    const active = await activeTask(alice);
    await activeTask(bob);
    const bobBefore = await counts(bob);
    const carolBefore = await counts(carol);

    // 100 days later.
    const later = { db: h.db, now: () => new Date(Date.now() + 100 * DAY) };
    const swept = await sweepUser(later, alice);
    expect(swept).toEqual({
      memories: 1,
      tasks: 1,
      conversations: 1,
      uploads: 1,
      webhookDeliveries: 1,
    });

    const after = await counts(alice);
    expect(after.memories).toEqual(['Recent note.']);
    expect(after.tasks).toEqual([a.recent, active].sort()); // the queued task is not finished: kept
    expect(after.attachments).toEqual([]); // the old conversation's file and the expired upload
    expect(after.deliveries).toBe(0);
    expect(after.messages.every((t) => t === a.recent || t === active)).toBe(true);
    // Steps, events and approvals went with the task (cascade).
    const leftovers = await asOwner<{ n: number }>(
      `SELECT (SELECT count(*) FROM task_steps WHERE task_id = $1)
            + (SELECT count(*) FROM task_events WHERE task_id = $1)
            + (SELECT count(*) FROM task_attachments WHERE task_id = $1) AS n`,
      [a.old],
    );
    expect(Number(leftovers[0]!.n)).toBe(0);

    // Other users are untouched — even one with the same settings, until their own sweep.
    expect(await counts(bob)).toEqual(bobBefore);
    expect(await counts(carol)).toEqual(carolBefore);
    expect(await sweepUser(later, carol)).toEqual({
      memories: 0,
      tasks: 0,
      conversations: 0,
      uploads: 1,
      webhookDeliveries: 1,
    });
    expect((await counts(carol)).tasks).toEqual(carolBefore.tasks);
    expect((await counts(carol)).memories).toEqual(carolBefore.memories);

    // The stored objects are queued by the trigger and deleted by the drain.
    const keys = [a.file, a.upload].map(
      (id) => `tenants/${alice.tenantId}/users/${alice.userId}/attachments/${id}`,
    );
    await h.storage!.getBuffer(keys[0]!); // still there until the drain runs
    await drainStorageDeletions({ db: h.db, storage: h.storage, log: h.worker.log, limit: 500 });
    for (const key of keys)
      await expect(h.storage!.getBuffer(key)).rejects.toBeInstanceOf(StorageNotFoundError);
    // Bob's files are still stored.
    await h.storage!.getBuffer(`tenants/${bob.tenantId}/users/${bob.userId}/attachments/${b.file}`);

    // Counts only in the audit log.
    const meta = await auditMetadata(alice.userId, 'retention.swept');
    expect(meta).toEqual([]); // system actor: recorded without the user as actor
    const rows = await asOwner<{ metadata: Record<string, number> }>(
      `SELECT metadata FROM audit_events WHERE action = 'retention.swept' AND target_id = $1`,
      [alice.userId],
    );
    expect(rows.map((r) => r.metadata)).toEqual([swept]);
  });

  it('the daily enqueue finds users with retention settings or expired data, one job each', async () => {
    const dave = await newUser(h.db, { retention: { memoryDays: 90, taskHistoryDays: null } });
    const erin = await newUser(h.db, { ...DEFAULT_PREFERENCES });
    await enqueueRetentionSweeps(h.worker);
    await enqueueRetentionSweeps(h.worker); // deduplicated while queued
    const jobs = await h.db
      .selectFrom('jobs')
      .select(['user_id'])
      .where('kind', '=', 'retention.sweep')
      .where('status', '=', 'queued')
      .execute();
    const users = jobs.map((j) => j.user_id);
    expect(users.filter((u) => u === dave.userId)).toHaveLength(1);
    expect(users).not.toContain(erin.userId);
    await drain(h.worker);
    const done = await h.db
      .selectFrom('jobs')
      .select('status')
      .where('kind', '=', 'retention.sweep')
      .where('user_id', '=', dave.userId)
      .execute();
    expect(done.map((j) => j.status)).toEqual(['succeeded']);
  });
});
