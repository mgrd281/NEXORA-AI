import { access } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Attachment,
  Schedule,
  TaskSummary,
  WebhookEndpointWithSecret,
} from '@jarvis/contracts';
import { withContext } from '../../../src/db/pool';
import { TEST_PASSWORD } from '../helpers';
import { makePdf } from '../../unit/http/zip-fixture';
import { fileUpload } from './multipart';
import { createHarness, newClient, ownerQuery, type Client, type Harness } from './support';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

async function uploadFile(c: Client, name: string, data: Buffer | string): Promise<Attachment> {
  const { payload, headers } = fileUpload(name, data);
  const res = await c.request('POST', '/v1/attachments', payload, headers);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Attachment>();
}

async function keysOf(c: Client): Promise<string[]> {
  const rows = await withContext(h.db, c.user, (trx) =>
    trx.selectFrom('attachments').select('storage_key').orderBy('created_at').execute(),
  );
  return rows.map((r) => r.storage_key);
}

const exists = (key: string) =>
  access(path.join(h.storageDir!, ...key.split('/'))).then(
    () => true,
    () => false,
  );

async function seedPhaseB(c: Client) {
  const pdf = await uploadFile(c, 'contract.pdf', makePdf('Contract text'));
  const notes = await uploadFile(c, 'notes.md', '# Notes\nhello');
  const task = (
    await c.request('POST', '/v1/tasks', {
      request: 'Summarise the contract',
      attachmentIds: [pdf.id],
    })
  ).json<TaskSummary>();
  const schedule = (
    await c.request('POST', '/v1/schedules', {
      title: 'Weekly',
      request: 'Summarize https://example.com and email it to me',
      recurrence: {
        frequency: 'weekly',
        byWeekday: ['MO'],
        time: '09:00',
        timeZone: 'Europe/Berlin',
      },
    })
  ).json<Schedule>();
  const webhook = (
    await c.request('POST', '/v1/webhooks', {
      url: 'https://93.184.215.14/hook',
      eventTypes: ['task.completed'],
    })
  ).json<WebhookEndpointWithSecret>();
  await c.request('POST', `/v1/webhooks/${webhook.endpoint.id}/test`);
  return { pdf, notes, task, schedule, webhook };
}

describe('account export v3', () => {
  it('contains attachment metadata and the files, schedules and webhooks — and no secrets', async () => {
    const c = await newClient(h);
    const { pdf, notes, task, schedule, webhook } = await seedPhaseB(c);
    const res = await c.request('POST', '/v1/account/export');
    expect(res.statusCode).toBe(200);
    const doc = res.json<Record<string, unknown>>();
    expect(doc.version).toBe(5); // Phase D: version 5 (a superset of 4)

    const files = doc.attachments as (Attachment & {
      content: { encoding: string; data: string } | null;
      contentOmitted: string | null;
    })[];
    expect(files.map((f) => f.id)).toEqual([pdf.id, notes.id]);
    expect(files[0]).toMatchObject({
      filename: 'contract.pdf',
      mediaType: 'application/pdf',
      sha256: pdf.sha256,
      downloadPath: pdf.downloadPath,
      conversationId: task.conversationId,
      contentOmitted: null,
    });
    expect(Buffer.from(files[0]!.content!.data, 'base64')).toEqual(makePdf('Contract text'));
    expect(Buffer.from(files[1]!.content!.data, 'base64').toString()).toBe('# Notes\nhello');

    const tasks = doc.tasks as {
      id: string;
      attachmentIds: string[];
      attachmentCount: number;
      conversationId: string;
    }[];
    expect(tasks.find((t) => t.id === task.id)).toMatchObject({
      attachmentIds: [pdf.id],
      attachmentCount: 1,
    });

    const schedules = doc.scheduledTasks as (Schedule & { runs: unknown[] })[];
    expect(schedules).toEqual([
      expect.objectContaining({
        id: schedule.id,
        rrule: schedule.rrule,
        request: schedule.request,
        runs: [],
      }),
    ]);

    const hooks = doc.webhooks as {
      id: string;
      secretHint: string;
      deliveries: { eventType: string }[];
    }[];
    expect(hooks).toEqual([
      expect.objectContaining({
        id: webhook.endpoint.id,
        secretHint: webhook.endpoint.secretHint,
        deliveries: [expect.objectContaining({ eventType: 'webhook.test' })],
      }),
    ]);

    // No secrets: the webhook secret, its envelope, storage keys.
    const row = await withContext(h.db, c.user, (trx) =>
      trx.selectFrom('webhook_endpoints').select('secret_ciphertext').executeTakeFirstOrThrow(),
    );
    for (const needle of [
      webhook.secret,
      webhook.secret.slice(6),
      row.secret_ciphertext.toString('base64'),
      row.secret_ciphertext.toString('hex'),
      ...(await keysOf(c)),
      TEST_PASSWORD,
      c.token,
    ])
      expect(res.body).not.toContain(needle);
    expect(res.body).not.toMatch(/secret_ciphertext|secretCiphertext|storage_key|storageKey/);
  });

  it('lists files beyond the size budget by download path instead of embedding them', async () => {
    const { embedExportFiles } = await import('../../../src/modules/account/export');
    const doc = {
      attachments: [
        { id: 'a', content: null, contentOmitted: null },
        { id: 'b', content: null, contentOmitted: null },
      ],
    };
    const c = await newClient(h);
    const a = await uploadFile(c, 'a.txt', 'aaaa');
    const b = await uploadFile(c, 'b.txt', 'bbbbbbbb');
    const files = await withContext(h.db, c.user, (trx) =>
      trx
        .selectFrom('attachments')
        .select(['id', 'size_bytes', 'storage_driver', 'storage_key', 'sha256'])
        .orderBy('created_at')
        .execute(),
    );
    doc.attachments[0]!.id = a.id;
    doc.attachments[1]!.id = b.id;
    await embedExportFiles(doc, files, h.storage, { warn() {} }, 6);
    expect(doc.attachments[0]).toMatchObject({
      content: { encoding: 'base64' },
      contentOmitted: null,
    });
    expect(doc.attachments[1]).toMatchObject({
      content: null,
      contentOmitted: 'EXPORT_SIZE_LIMIT',
    });
    const none = { attachments: [{ id: a.id, content: null, contentOmitted: null }] };
    await embedExportFiles(none, files, null, { warn() {} });
    expect(none.attachments[0]).toMatchObject({
      content: null,
      contentOmitted: 'STORAGE_NOT_CONFIGURED',
    });
  });
});

describe('account delete', () => {
  it('removes the stored files and queues each for the storage drain', async () => {
    const c = await newClient(h);
    await seedPhaseB(c);
    const keys = await keysOf(c);
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(await exists(k)).toBe(true);

    const res = await c.request('POST', '/v1/account/delete', {
      password: TEST_PASSWORD,
      confirmation: 'DELETE',
    });
    expect(res.statusCode).toBe(204);
    for (const k of keys) expect(await exists(k), k).toBe(false);
    // The outbox guarantees deletion even if the immediate delete had failed.
    const queued = await ownerQuery<{ storage_key: string }>(
      'SELECT storage_key FROM storage_deletions WHERE storage_key = ANY($1) ORDER BY storage_key',
      [keys],
    );
    expect(queued.map((q) => q.storage_key)).toEqual([...keys].sort());
    // Schedules, webhooks and deliveries went with the account.
    const left = await ownerQuery<{ n: number }>(
      `SELECT (SELECT count(*) FROM scheduled_tasks WHERE user_id = $1)
            + (SELECT count(*) FROM webhook_endpoints WHERE user_id = $1)
            + (SELECT count(*) FROM webhook_deliveries WHERE user_id = $1)
            + (SELECT count(*) FROM attachments WHERE user_id = $1) AS n`,
      [c.user.userId],
    );
    expect(Number(left[0]!.n)).toBe(0);
  });
});
