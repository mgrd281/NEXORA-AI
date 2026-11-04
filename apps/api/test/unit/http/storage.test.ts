import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config';
import { createStorage } from '../../../src/modules/storage';
import { isValidStorageKey } from '../../../src/modules/storage/keys';
import { createLocalStorage } from '../../../src/modules/storage/local';
import { createS3Storage, type S3Like } from '../../../src/modules/storage/s3';
import {
  attachmentStorageKey,
  StorageNotFoundError,
  StorageUnavailableError,
} from '../../../src/modules/storage/types';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const key = () =>
  attachmentStorageKey({
    tenantId: randomUUID(),
    userId: randomUUID(),
    attachmentId: randomUUID(),
  });

async function readStream(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

const BAD_KEYS = [
  '/etc/passwd',
  '../tenants/x',
  `tenants/${randomUUID()}/users/${randomUUID()}/attachments/../../x`,
  `tenants/${randomUUID()}/users/${randomUUID()}/files/${randomUUID()}`,
  `tenants/${randomUUID()}/users/${randomUUID()}/attachments/${randomUUID()}/x`,
  '',
];

describe('storage keys', () => {
  it('accepts only the per-tenant attachment key shape', () => {
    expect(isValidStorageKey(key())).toBe(true);
    for (const k of BAD_KEYS) expect(isValidStorageKey(k), k).toBe(false);
  });
});

describe('local storage driver', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jarvis-local-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('stores, reads, streams and deletes objects (0600 files in 0700 directories)', async () => {
    const s = createLocalStorage(dir);
    expect(s.driver).toBe('local');
    expect(await s.ping()).toBe(true);
    const k = key();
    const body = Buffer.from('hello attachment');
    await s.put(k, { body, contentType: 'text/plain', sha256: sha(body) });
    const file = path.join(dir, ...k.split('/'));
    expect(await readFile(file)).toEqual(body);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await s.getBuffer(k)).toEqual(body);
    expect(await readStream(await s.get(k))).toEqual(body);
    // Replacing keeps one object.
    const next = Buffer.from('second version');
    await s.put(k, { body: next, contentType: 'text/plain', sha256: sha(next) });
    expect(await s.getBuffer(k)).toEqual(next);
    await s.delete(k);
    await s.delete(k); // idempotent
    await expect(s.getBuffer(k)).rejects.toBeInstanceOf(StorageNotFoundError);
    await expect(s.get(k)).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it('verifies the checksum before reporting success', async () => {
    const s = createLocalStorage(dir);
    const k = key();
    await expect(
      s.put(k, {
        body: Buffer.from('a'),
        contentType: 'text/plain',
        sha256: sha(Buffer.from('b')),
      }),
    ).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(s.getBuffer(k)).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it('rejects keys outside the allowed shape', async () => {
    const s = createLocalStorage(dir);
    for (const k of BAD_KEYS) {
      await expect(s.getBuffer(k)).rejects.toThrow('Invalid storage key');
      await expect(s.delete(k)).rejects.toThrow('Invalid storage key');
    }
  });
});

describe('S3 storage driver', () => {
  const base = {
    S3_BUCKET: 'jarvis-test',
    S3_REGION: 'eu-central-1',
    S3_ENDPOINT: undefined,
    S3_FORCE_PATH_STYLE: false,
    S3_PREFIX: 'prod/',
    S3_SSE: 'AES256' as const,
    S3_SSE_KMS_KEY_ID: undefined,
  };

  function fakeClient(handler: (cmd: unknown) => unknown = () => ({})) {
    const sent: unknown[] = [];
    const client: S3Like = {
      async send(cmd) {
        sent.push(cmd);
        return handler(cmd);
      },
    };
    return { client, sent };
  }

  it('encrypts and checksums every PUT under the deployment prefix', async () => {
    const { client, sent } = fakeClient();
    const s = createS3Storage(base, client);
    const k = key();
    const body = Buffer.from('%PDF-1.4 test');
    await s.put(k, { body, contentType: 'application/pdf', sha256: sha(body) });
    const put = sent[0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({
      Bucket: 'jarvis-test',
      Key: `prod/${k}`,
      ContentType: 'application/pdf',
      ContentLength: body.length,
      ServerSideEncryption: 'AES256',
      ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
    });
    expect(put.input.SSEKMSKeyId).toBeUndefined();
  });

  it('uses the KMS key with aws:kms', async () => {
    const { client, sent } = fakeClient();
    const s = createS3Storage(
      { ...base, S3_SSE: 'aws:kms', S3_SSE_KMS_KEY_ID: 'kms-key-1' },
      client,
    );
    const body = Buffer.from('x');
    await s.put(key(), { body, contentType: 'text/plain', sha256: sha(body) });
    expect((sent[0] as PutObjectCommand).input).toMatchObject({
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'kms-key-1',
    });
  });

  it('streams objects and maps missing objects and failures', async () => {
    const k = key();
    const { client, sent } = fakeClient((cmd) => {
      if (cmd instanceof GetObjectCommand) {
        if (cmd.input.Key === `prod/${k}`) return { Body: Readable.from([Buffer.from('bytes')]) };
        throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      }
      if (cmd instanceof DeleteObjectCommand)
        throw Object.assign(new Error('gone'), { $metadata: { httpStatusCode: 404 } });
      if (cmd instanceof HeadBucketCommand) throw new Error('no access');
      return {};
    });
    const s = createS3Storage(base, client);
    expect(await s.getBuffer(k)).toEqual(Buffer.from('bytes'));
    await expect(s.get(key())).rejects.toBeInstanceOf(StorageNotFoundError);
    await s.delete(k); // a missing object is not an error
    expect(await s.ping()).toBe(false);
    expect(sent.some((c) => c instanceof DeleteObjectCommand)).toBe(true);

    const failing = createS3Storage(base, {
      async send() {
        throw new Error('network down');
      },
    });
    const body = Buffer.from('x');
    await expect(
      failing.put(key(), { body, contentType: 'text/plain', sha256: sha(body) }),
    ).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(failing.get(key())).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(failing.delete(key())).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('rejects keys outside the allowed shape before calling S3', async () => {
    const { client, sent } = fakeClient();
    const s = createS3Storage(base, client);
    await expect(s.getBuffer('../../other-tenant')).rejects.toThrow('Invalid storage key');
    expect(sent).toHaveLength(0);
  });
});

describe('createStorage', () => {
  const env = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  };

  it('builds the configured driver', () => {
    expect(
      createStorage(loadConfig({ ...env, NODE_ENV: 'test', STORAGE_DRIVER: 'none' })),
    ).toBeNull();
    expect(createStorage(loadConfig({ ...env, NODE_ENV: 'test' }))?.driver).toBe('local');
    expect(
      createStorage(
        loadConfig({ ...env, NODE_ENV: 'test', STORAGE_DRIVER: 's3', S3_BUCKET: 'bucket-a' }),
      )?.driver,
    ).toBe('s3');
    // Production defaults to none (uploads unavailable, said so in the UI).
    expect(
      createStorage(
        loadConfig({ ...env, NODE_ENV: 'production', WEB_ORIGIN: 'https://app.example.com' }),
      ),
    ).toBeNull();
  });

  it('refuses the local driver in production even if config were bypassed', () => {
    const config = loadConfig({ ...env, NODE_ENV: 'test' });
    expect(() => createStorage({ ...config, isProduction: true })).toThrow(
      /not allowed in production/,
    );
  });
});
