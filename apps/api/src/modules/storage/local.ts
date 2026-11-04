/**
 * Local filesystem driver (STORAGE_DRIVER=local): development and tests only
 * (config refuses it in production). Objects live under STORAGE_LOCAL_DIR at
 * their key; directories are 0700 and files 0600. Writes go to a temporary
 * file that is fsynced and renamed into place, so a reader never sees a
 * partial object and a crash leaves no half-written file under the key.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { assertStorageKey } from './keys';
import {
  StorageNotFoundError,
  StorageUnavailableError,
  type ObjectStorage,
  type PutObjectInput,
} from './types';

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export function createLocalStorage(dir: string): ObjectStorage {
  const root = path.resolve(dir);

  function fileFor(key: string): string {
    assertStorageKey(key);
    const file = path.resolve(root, ...key.split('/'));
    // Defence in depth: the key shape already rules this out.
    if (!file.startsWith(root + path.sep)) throw new Error('Invalid storage key');
    return file;
  }

  const unavailable = (op: string, err: unknown) =>
    new StorageUnavailableError(`Local storage ${op} failed`, { cause: err });

  return {
    driver: 'local',

    async put(key: string, input: PutObjectInput): Promise<void> {
      const file = fileFor(key);
      const actual = createHash('sha256').update(input.body).digest('hex');
      if (actual !== input.sha256) throw new StorageUnavailableError('Checksum mismatch');
      const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
      try {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const handle = await open(tmp, 'wx', 0o600);
        try {
          await handle.writeFile(input.body);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(tmp, file);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw unavailable('write', err);
      }
    },

    async get(key: string): Promise<Readable> {
      const file = fileFor(key);
      try {
        // Open first so a missing object is reported here, not as a stream error.
        const handle = await open(file, 'r');
        return handle.createReadStream();
      } catch (err) {
        if (isNotFound(err)) throw new StorageNotFoundError(key);
        throw unavailable('read', err);
      }
    },

    async getBuffer(key: string): Promise<Buffer> {
      const file = fileFor(key);
      try {
        return await readFile(file);
      } catch (err) {
        if (isNotFound(err)) throw new StorageNotFoundError(key);
        throw unavailable('read', err);
      }
    },

    async delete(key: string): Promise<void> {
      const file = fileFor(key);
      try {
        await rm(file, { force: true });
      } catch (err) {
        throw unavailable('delete', err);
      }
    },

    async ping(): Promise<boolean> {
      try {
        await mkdir(root, { recursive: true, mode: 0o700 });
        await access(root, constants.R_OK | constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}
