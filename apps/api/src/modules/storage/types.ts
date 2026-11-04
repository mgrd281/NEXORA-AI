/**
 * Object storage for attachments — the interface every driver implements and
 * every consumer uses (FROZEN in Phase B stage 1; docs/architecture/phase-b.md §4.3).
 *
 *   Drivers (owned by the HTTP engineer, same directory):
 *     local.ts  — a directory (STORAGE_LOCAL_DIR); development and tests only
 *     s3.ts     — @aws-sdk/client-s3; any S3-compatible service; SSE on every PUT
 *     index.ts  — createStorage(config): ObjectStorage | null (null when 'none')
 *   Consumers:
 *     modules/attachments (upload, download, delete),
 *     modules/agent tools/document-analyze.ts (read),
 *     modules/agent jobs/retention.ts (drain storage_deletions).
 *
 * Keys are relative and fixed by the database (attachments_storage_key_format):
 *   tenants/<tenant id>/users/<user id>/attachments/<attachment id>
 * A driver may only prepend its deployment prefix (S3_PREFIX) and must reject
 * a key that is not in that form, absolute, or contains "..".
 */
import type { Readable } from 'node:stream';
import type { StorageDriver } from '../../config';

export interface PutObjectInput {
  /** The whole object (attachments are at most ATTACHMENT_LIMITS.maxBytes). */
  body: Buffer;
  /** The sniffed media type; stored as the object's Content-Type. */
  contentType: string;
  /** Hex SHA-256 of `body`; drivers verify it (S3: ChecksumSHA256) before reporting success. */
  sha256: string;
}

export interface ObjectStorage {
  readonly driver: Exclude<StorageDriver, 'none'>;
  /** Stores the object, replacing an object with the same key. Resolves once it is durable. */
  put(key: string, input: PutObjectInput): Promise<void>;
  /** The object's bytes as a stream; rejects with StorageNotFoundError when it does not exist. */
  get(key: string): Promise<Readable>;
  /** The whole object (for extraction; size is bounded by the upload limit). */
  getBuffer(key: string): Promise<Buffer>;
  /** Deletes the object. Idempotent: a missing object is not an error. */
  delete(key: string): Promise<void>;
  /** Cheap health probe (used by readiness and the status service). */
  ping(): Promise<boolean>;
}

/** The object does not exist (deleted, or never stored). */
export class StorageNotFoundError extends Error {
  constructor(readonly key: string) {
    super('Stored object not found');
    this.name = 'StorageNotFoundError';
  }
}

/** The storage service failed (network, credentials, checksum); retryable. */
export class StorageUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageUnavailableError';
  }
}

/** The one key format the database accepts for an attachment. */
export function attachmentStorageKey(ids: {
  tenantId: string;
  userId: string;
  attachmentId: string;
}): string {
  return `tenants/${ids.tenantId}/users/${ids.userId}/attachments/${ids.attachmentId}`;
}
