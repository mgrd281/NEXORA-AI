import { randomUUID } from 'node:crypto';
import { DEFAULT_PREFERENCES, type Preferences } from '@jarvis/contracts';
import { loadConfig, type Config } from '../../src/config';
import { createDb, withContext, type Db, type DbContext } from '../../src/db/pool';
import { SecretBox } from '../../src/lib/crypto';
import { hashPassword } from '../../src/modules/auth/password';
import { TEST_APP_URL } from './env';

export const TEST_PASSWORD = 'test-password-123456';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_APP_URL,
    WEB_ORIGIN: 'http://localhost:3000',
    SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    SMTP_ALLOW_INSECURE_LOCALHOST: 'true',
    ...overrides,
  });
}

export function testDb(): Db {
  return createDb(TEST_APP_URL, 5).db;
}

export function testSecrets(config: Config): SecretBox {
  return new SecretBox(config.SECRET_ENCRYPTION_KEY, config.SECRET_ENCRYPTION_KEY_ID);
}

let passwordHash: Promise<string> | undefined;

export interface TestUser extends DbContext {
  email: string;
  password: string;
}

/** Creates an isolated tenant + user (+ roles) directly through RLS-scoped inserts. */
export async function createTestUser(
  db: Db,
  opts: {
    admin?: boolean;
    email?: string;
    preferences?: Partial<Preferences>;
    locale?: 'en' | 'de' | 'ar';
  } = {},
): Promise<TestUser> {
  passwordHash ??= hashPassword(TEST_PASSWORD);
  const tenantId = randomUUID();
  const userId = randomUUID();
  const email = opts.email ?? `user-${userId.slice(0, 8)}@test.local`;
  await withContext(db, { tenantId, userId }, async (trx) => {
    await trx.insertInto('tenants').values({ id: tenantId, name: 'Test tenant' }).execute();
    await trx
      .insertInto('users')
      .values({
        id: userId,
        tenant_id: tenantId,
        email,
        display_name: 'Test User',
        password_hash: await passwordHash!,
        locale: opts.locale ?? 'en',
        preferences: JSON.stringify({ ...DEFAULT_PREFERENCES, ...opts.preferences }),
      })
      .execute();
    await trx
      .insertInto('user_roles')
      .values({ tenant_id: tenantId, user_id: userId, role: 'owner' })
      .execute();
    if (opts.admin) {
      await trx
        .insertInto('user_roles')
        .values({ tenant_id: tenantId, user_id: userId, role: 'platform_admin' })
        .execute();
    }
  });
  return { tenantId, userId, email, password: TEST_PASSWORD };
}
