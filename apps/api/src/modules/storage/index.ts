/**
 * Builds the configured attachment storage (docs/architecture/phase-b.md §3.3):
 *   none  → null (uploads unavailable; the API answers 503 STORAGE_NOT_CONFIGURED
 *           and the UI says so)
 *   local → a directory (development/test only; refused in production)
 *   s3    → S3 or an S3-compatible service, SSE on every object
 * Called once per process by server.ts and worker.ts.
 */
import type { Config } from '../../config';
import { createLocalStorage } from './local';
import { createS3Storage, type S3StorageConfig } from './s3';
import type { ObjectStorage } from './types';

/** What createStorage reads (the API, the agent worker and the browser worker all have it). */
export type StorageConfig = Pick<Config, 'storageDriver' | 'isProduction' | 'STORAGE_LOCAL_DIR'> &
  S3StorageConfig;

export function createStorage(config: StorageConfig): ObjectStorage | null {
  switch (config.storageDriver) {
    case 'none':
      return null;
    case 'local':
      // loadConfig refuses this already; repeated so no caller can bypass it.
      if (config.isProduction) throw new Error('STORAGE_DRIVER=local is not allowed in production');
      return createLocalStorage(config.STORAGE_LOCAL_DIR);
    case 's3':
      return createS3Storage(config);
  }
}

export * from './types';
export { isValidStorageKey } from './keys';
