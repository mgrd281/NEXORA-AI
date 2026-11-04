import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ATTACHMENT_LIMITS,
  type Attachment,
  type TaskDetail,
  type TaskSummary,
} from '@jarvis/contracts';
import { withContext } from '../../../src/db/pool';
import { StorageNotFoundError, StorageUnavailableError } from '../../../src/modules/storage/types';
import { makeDocx, makePdf } from '../../unit/http/zip-fixture';
import { fileUpload, multipartBody } from './multipart';
import { createHarness, newClient, ownerQuery, type Client, type Harness } from './support';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function upload(c: Client, filename: string, data: Buffer | string, contentType?: string) {
  const { payload, headers } = fileUpload(filename, data, contentType);
  return c.request('POST', '/v1/attachments', payload, headers);
}

async function uploaded(c: Client, filename: string, data: Buffer | string): Promise<Attachment> {
  const res = await upload(c, filename, data);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Attachment>();
}

const fileOf = (key: string) => path.join(h.storageDir!, ...key.split('/'));
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

async function storedKey(c: Client, id: string): Promise<string> {
  const row = await withContext(h.db, c.user, (trx) =>
    trx
      .selectFrom('attachments')
      .select('storage_key')
      .where('id', '=', id)
      .executeTakeFirstOrThrow(),
  );
  return row.storage_key;
}

describe('upload', () => {
  it('stores each accepted type, identified from its content, under the tenant prefix', async () => {
    const c = await newClient(h);
    const cases: [string, Buffer | string, string][] = [
      ['report.pdf', makePdf(), 'application/pdf'],
      ['letter.docx', makeDocx(), DOCX],
      ['notes.txt', 'Plain notes\n', 'text/plain'],
      ['README.md', '# Heading\n', 'text/markdown'],
      ['data.csv', 'a,b\n1,2\n', 'text/csv'],
    ];
    for (const [name, data, type] of cases) {
      // The declared part type is ignored (sent as octet-stream here).
      const a = await uploaded(c, name, data);
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      expect(a).toMatchObject({
        filename: name,
        mediaType: type,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        conversationId: null,
        pageCount: null,
        textChars: null,
        downloadPath: `/v1/attachments/${a.id}/content`,
      });
      // Unattached uploads expire after 24 h.
      const ttl = new Date(a.expiresAt!).getTime() - new Date(a.createdAt).getTime();
      expect(Math.round(ttl / 3_600_000)).toBe(ATTACHMENT_LIMITS.unattachedTtlHours);
      const key = await storedKey(c, a.id);
      expect(key).toBe(`tenants/${c.user.tenantId}/users/${c.user.userId}/attachments/${a.id}`);
      expect(await readFile(fileOf(key))).toEqual(bytes);
    }
  });

  it('refuses a .pdf that is really HTML, and other spoofed or unsupported files (415)', async () => {
    const c = await newClient(h);
    const html = '<!doctype html><html><script>alert(document.cookie)</script></html>';
    const spoofed = await upload(c, 'invoice.pdf', html, 'application/pdf');
    expect(spoofed.statusCode).toBe(415);
    expect(spoofed.json().error).toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      details: { reason: 'FILE_CONTENT_MISMATCH' },
    });
    expect((await upload(c, 'page.html', html, 'text/html')).json().error.details.reason).toBe(
      'UNSUPPORTED_FILE_TYPE',
    );
    const macro = makeDocx('x', [{ name: 'word/vbaProject.bin', data: Buffer.alloc(32, 7) }]);
    expect((await upload(c, 'macro.docx', macro)).json().error.details.reason).toBe(
      'UNSUPPORTED_FILE_TYPE',
    );
    const bomb = makeDocx('x', [
      { name: 'word/zeros.bin', data: Buffer.alloc(3 * 1024 * 1024), deflate: true },
    ]);
    const bombRes = await upload(c, 'bomb.docx', bomb);
    expect(bombRes.statusCode).toBe(415);
    expect(bombRes.json().error.details.reason).toBe('UNSUPPORTED_FILE_TYPE');
    const png = Buffer.from('89504e470d0a1a0a0000000d494844520000', 'hex');
    expect((await upload(c, 'image.png', png)).statusCode).toBe(415);
    // Nothing was stored for any of them.
    const rows = await withContext(h.db, c.user, (trx) =>
      trx.selectFrom('attachments').select('id').execute(),
    );
    expect(rows).toEqual([]);
  });

  it('enforces the size limit (413) and refuses empty files (400)', async () => {
    const c = await newClient(h);
    const atLimit = Buffer.alloc(ATTACHMENT_LIMITS.maxBytes, 'a');
    const ok = await upload(c, 'big.txt', atLimit);
    expect(ok.statusCode, ok.body).toBe(201);
    const over = await upload(c, 'bigger.txt', Buffer.alloc(ATTACHMENT_LIMITS.maxBytes + 1, 'a'));
    expect(over.statusCode).toBe(413);
    expect(over.json().error).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      details: { reason: 'FILE_TOO_LARGE', limitBytes: ATTACHMENT_LIMITS.maxBytes },
    });
    // A declared length far beyond the limit is refused before reading.
    const far = await upload(
      c,
      'huge.txt',
      Buffer.alloc(ATTACHMENT_LIMITS.maxBytes + 200_000, 'a'),
    );
    expect(far.statusCode).toBe(413);
    const empty = await upload(c, 'empty.txt', '');
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.details.reason).toBe('FILE_EMPTY');
  });

  it('needs exactly one file in the "file" field, as multipart/form-data', async () => {
    const c = await newClient(h);
    const two = multipartBody([
      { field: 'file', filename: 'a.txt', data: 'a' },
      { field: 'file', filename: 'b.txt', data: 'b' },
    ]);
    expect((await c.request('POST', '/v1/attachments', two.payload, two.headers)).statusCode).toBe(
      400,
    );
    const wrongField = multipartBody([{ field: 'document', filename: 'a.txt', data: 'a' }]);
    expect(
      (await c.request('POST', '/v1/attachments', wrongField.payload, wrongField.headers))
        .statusCode,
    ).toBe(400);
    const fieldOnly = multipartBody([{ field: 'note', data: 'hello' }]);
    expect(
      (await c.request('POST', '/v1/attachments', fieldOnly.payload, fieldOnly.headers)).statusCode,
    ).toBe(400);
    const json = await c.request('POST', '/v1/attachments', { file: 'x' });
    expect(json.statusCode).toBe(415);
    expect(json.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    // Multipart is only parsed on the upload route.
    const elsewhere = fileUpload('a.txt', 'a');
    const memory = await c.request('POST', '/v1/memories', elsewhere.payload, elsewhere.headers);
    expect(memory.statusCode).toBe(415);
  });

  it('sanitises the file name and never audits it', async () => {
    const c = await newClient(h);
    const a = await uploaded(c, 'C:\\fake\\path\\inv\u202eoice.txt', 'hello');
    expect(a.filename).toBe('invoice.txt');
    const audits = await ownerQuery(
      'SELECT action, metadata FROM audit_events WHERE target_id = $1 ORDER BY id',
      [a.id],
    );
    expect(audits).toEqual([
      { action: 'attachment.uploaded', metadata: { mediaType: 'text/plain', sizeBytes: 5 } },
    ]);
  });

  it('answers 503 STORAGE_UNAVAILABLE when storage fails, and keeps no row', async () => {
    const failing = await createHarness({
      storage: {
        driver: 'local',
        put: async () => {
          throw new StorageUnavailableError('disk full');
        },
        get: async (key) => {
          throw new StorageNotFoundError(key);
        },
        getBuffer: async (key) => {
          throw new StorageNotFoundError(key);
        },
        delete: async () => {},
        ping: async () => false,
      },
    });
    try {
      const c = await newClient(failing);
      const { payload, headers } = fileUpload('a.txt', 'hello');
      const res = await c.request('POST', '/v1/attachments', payload, headers);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.details.reason).toBe('STORAGE_UNAVAILABLE');
      const rows = await withContext(failing.db, c.user, (trx) =>
        trx.selectFrom('attachments').select('id').execute(),
      );
      expect(rows).toEqual([]);
    } finally {
      await failing.close();
    }
  });

  it('answers 503 STORAGE_NOT_CONFIGURED when the server has no storage', async () => {
    const off = await createHarness({ storage: null });
    try {
      const c = await newClient(off);
      const { payload, headers } = fileUpload('a.txt', 'hello');
      const res = await c.request('POST', '/v1/attachments', payload, headers);
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        details: { reason: 'STORAGE_NOT_CONFIGURED' },
      });
    } finally {
      await off.close();
    }
  });
});

describe('metadata, download and delete', () => {
  it('streams the file to its owner with safe headers', async () => {
    const c = await newClient(h);
    const name = 'تقرير Q1 (final).txt';
    const a = await uploaded(c, name, 'Umsatz: 42 €\n');
    const meta = await c.request('GET', `/v1/attachments/${a.id}`);
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toEqual(a);

    const res = await c.request('GET', a.downloadPath);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(Buffer.from('Umsatz: 42 €\n'));
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['content-length']).toBe(String(a.sizeBytes));
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(res.headers['cache-control']).toBe('private, no-store');
    const cd = String(res.headers['content-disposition']);
    expect(cd.startsWith('attachment; filename="')).toBe(true);
    expect(decodeURIComponent(cd.split("filename*=UTF-8''")[1]!)).toBe(name);
    expect(cd).not.toMatch(/[^\x20-\x7e]/);

    const pdf = await uploaded(c, 'doc.pdf', makePdf());
    const pdfRes = await c.request('GET', pdf.downloadPath);
    expect(pdfRes.headers['content-type']).toBe('application/pdf');
    expect(pdfRes.rawPayload).toEqual(makePdf());
  });

  it('is invisible to every other user (404), including download and delete', async () => {
    const owner = await newClient(h);
    const other = await newClient(h);
    const a = await uploaded(owner, 'private.txt', 'mine only');
    for (const [method, url] of [
      ['GET', `/v1/attachments/${a.id}`],
      ['GET', a.downloadPath],
      ['DELETE', `/v1/attachments/${a.id}`],
    ] as const) {
      const res = await other.request(method, url);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
    // Unauthenticated.
    expect((await h.app.inject({ method: 'GET', url: a.downloadPath })).statusCode).toBe(401);
    expect((await owner.request('GET', a.downloadPath)).statusCode).toBe(200);
  });

  it('deletes the row and the stored object; tasks that used it keep their results', async () => {
    const c = await newClient(h);
    const a = await uploaded(c, 'gone.txt', 'soon gone');
    const created = await c.request('POST', '/v1/tasks', {
      request: 'Summarise the attached notes',
      attachmentIds: [a.id],
    });
    expect(created.statusCode).toBe(202);
    const task = created.json<TaskSummary>();
    expect(task.attachmentCount).toBe(1);
    const detail = (await c.request('GET', `/v1/tasks/${task.id}`)).json<TaskDetail>();
    expect(detail.attachments).toEqual([
      expect.objectContaining({
        id: a.id,
        filename: 'gone.txt',
        conversationId: detail.conversationId,
        expiresAt: null,
      }),
    ]);

    const key = await storedKey(c, a.id);
    expect(await exists(fileOf(key))).toBe(true);
    const del = await c.request('DELETE', `/v1/attachments/${a.id}`);
    expect(del.statusCode).toBe(204);
    expect(await exists(fileOf(key))).toBe(false);
    expect((await c.request('GET', `/v1/attachments/${a.id}`)).statusCode).toBe(404);
    expect((await c.request('DELETE', `/v1/attachments/${a.id}`)).statusCode).toBe(404);
    const after = (await c.request('GET', `/v1/tasks/${task.id}`)).json<TaskDetail>();
    expect(after.id).toBe(task.id);
    expect(after.attachments).toEqual([]);
    expect(after.attachmentCount).toBe(0);
  });

  it('reports a missing stored object honestly (404), not as the file', async () => {
    const c = await newClient(h);
    const a = await uploaded(c, 'lost.txt', 'x');
    await h.storage!.delete(await storedKey(c, a.id));
    const res = await c.request('GET', a.downloadPath);
    expect(res.statusCode).toBe(404);
  });

  it('validates the id', async () => {
    const c = await newClient(h);
    expect((await c.request('GET', '/v1/attachments/not-a-uuid')).statusCode).toBe(400);
  });
});
