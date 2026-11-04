/** Shared helpers for agent unit tests (no database, no network). */
import { loadConfig, type Config } from '../../../src/config';

export function testConfigUnit(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
    SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    STORAGE_DRIVER: 'none',
    ...overrides,
  });
}
