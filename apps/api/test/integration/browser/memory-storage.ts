/**
 * Test double (tests only): an in-memory ObjectStorage for browser-agent
 * evidence. It enforces the same key shapes the database CHECKs allow
 * (attachments and evidence under the owner's prefix) and the SHA-256 the
 * drivers verify, so tests prove what is stored and under which key.
 * (The local driver's key check, storage/keys.ts, does not accept evidence
 * keys yet: see the contract request in the browser engineer's report.)
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  StorageNotFoundError,
  type ObjectStorage,
  type PutObjectInput,
} from '../../../src/modules/storage/types';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY = new RegExp(`^tenants/${UUID}/users/${UUID}/(attachments|evidence)/${UUID}$`);

export interface MemoryStorage extends ObjectStorage {
  readonly objects: Map<string, { body: Buffer; contentType: string; sha256: string }>;
}

export function memoryStorage(): MemoryStorage {
  const objects = new Map<string, { body: Buffer; contentType: string; sha256: string }>();
  const check = (key: string) => {
    if (!KEY.test(key)) throw new Error(`Invalid storage key: ${key}`);
  };
  return {
    driver: 'local',
    objects,
    async put(key: string, input: PutObjectInput) {
      check(key);
      const actual = createHash('sha256').update(input.body).digest('hex');
      if (actual !== input.sha256) throw new Error('Checksum mismatch');
      objects.set(key, {
        body: Buffer.from(input.body),
        contentType: input.contentType,
        sha256: actual,
      });
    },
    async get(key: string) {
      check(key);
      const o = objects.get(key);
      if (!o) throw new StorageNotFoundError(key);
      return Readable.from(o.body);
    },
    async getBuffer(key: string) {
      check(key);
      const o = objects.get(key);
      if (!o) throw new StorageNotFoundError(key);
      return o.body;
    },
    async delete(key: string) {
      check(key);
      objects.delete(key);
    },
    async ping() {
      return true;
    },
  };
}
