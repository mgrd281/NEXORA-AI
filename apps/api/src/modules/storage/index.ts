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
import { createS3Storage } from './s3';
import type { ObjectStorage } from './types';

export function createStorage(config: Config): ObjectStorage | null {
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
