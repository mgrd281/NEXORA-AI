/**
 * S3 driver (STORAGE_DRIVER=s3): AWS S3 or any S3-compatible service
 * (S3_ENDPOINT, S3_FORCE_PATH_STYLE). Credentials come from the AWS default
 * provider chain, never from JARVIS configuration.
 *
 * Encryption at rest: every PUT sets ServerSideEncryption (S3_SSE: AES256, or
 * aws:kms with S3_SSE_KMS_KEY_ID). Integrity: every PUT sends ChecksumSHA256,
 * which S3 verifies before it stores the object. The bucket itself must block
 * public access and deny unencrypted PUTs (docs/runbooks/operations.md).
 * Object keys are S3_PREFIX + the per-tenant key; they contain ids only.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import type { Config } from '../../config';
import { assertStorageKey, hexToBase64 } from './keys';
import {
  StorageNotFoundError,
  StorageUnavailableError,
  type ObjectStorage,
  type PutObjectInput,
} from './types';

/** The subset of S3Client this driver uses (lets unit tests substitute a fake). */
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

export type S3StorageConfig = Pick<
  Config,
  | 'S3_BUCKET'
  | 'S3_REGION'
  | 'S3_ENDPOINT'
  | 'S3_FORCE_PATH_STYLE'
  | 'S3_PREFIX'
  | 'S3_SSE'
  | 'S3_SSE_KMS_KEY_ID'
>;

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

export function createS3Client(config: S3StorageConfig): S3Client {
  return new S3Client({
    region: config.S3_REGION,
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
  });
}

export function createS3Storage(
  config: S3StorageConfig,
  client: S3Like = createS3Client(config),
): ObjectStorage {
  const bucket = config.S3_BUCKET;
  if (!bucket) throw new Error('STORAGE_DRIVER=s3 needs S3_BUCKET');
  const objectKey = (key: string) => {
    assertStorageKey(key);
    return `${config.S3_PREFIX}${key}`;
  };
  const unavailable = (op: string, err: unknown) =>
    new StorageUnavailableError(`S3 ${op} failed`, { cause: err });

  async function getBody(key: string): Promise<Readable> {
    const Key = objectKey(key);
    try {
      const out = (await client.send(new GetObjectCommand({ Bucket: bucket, Key }))) as {
        Body?: unknown;
      };
      const body = out.Body;
      if (body instanceof Readable) return body;
      if (
        body &&
        typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function'
      ) {
        const bytes = await (
          body as { transformToByteArray(): Promise<Uint8Array> }
        ).transformToByteArray();
        return Readable.from([Buffer.from(bytes)]);
      }
      throw new Error('S3 returned no body');
    } catch (err) {
      if (isNotFound(err)) throw new StorageNotFoundError(key);
      throw unavailable('get', err);
    }
  }

  return {
    driver: 's3',

    async put(key: string, input: PutObjectInput): Promise<void> {
      const params: PutObjectCommandInput = {
        Bucket: bucket,
        Key: objectKey(key),
        Body: input.body,
        ContentLength: input.body.length,
        ContentType: input.contentType,
        ChecksumSHA256: hexToBase64(input.sha256),
        ServerSideEncryption: config.S3_SSE,
        ...(config.S3_SSE === 'aws:kms' && config.S3_SSE_KMS_KEY_ID
          ? { SSEKMSKeyId: config.S3_SSE_KMS_KEY_ID }
          : {}),
      };
      try {
        await client.send(new PutObjectCommand(params));
      } catch (err) {
        throw unavailable('put', err);
      }
    },

    get: getBody,

    async getBuffer(key: string): Promise<Buffer> {
      const stream = await getBody(key);
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
      } catch (err) {
        throw unavailable('get', err);
      }
      return Buffer.concat(chunks);
    },

    async delete(key: string): Promise<void> {
      const Key = objectKey(key);
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
      } catch (err) {
        // Deleting a missing object is not an error (S3 itself answers 204).
        if (isNotFound(err)) return;
        throw unavailable('delete', err);
      }
    },

    async ping(): Promise<boolean> {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        return true;
      } catch {
        return false;
      }
    },
  };
}
