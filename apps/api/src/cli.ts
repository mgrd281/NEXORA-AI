/**
 * Operator CLI.
 *   pnpm --filter @jarvis/api cli create-owner --email you@example.com --name "Your Name" [--admin] [--locale en|de|ar] [--time-zone Europe/Berlin]
 * The password is read from JARVIS_OWNER_PASSWORD (never pass it as an argument —
 * it would end up in shell history). Public sign-up does not exist; this is how
 * accounts are created during Private Alpha.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_PREFERENCES } from '@jarvis/contracts';
import { loadConfig } from './config';
import { createDb, withContext } from './db/pool';
import { canonicalTimeZone } from './lib/period';
import { audit } from './modules/audit/audit';
import { hashPassword, MIN_PASSWORD_LENGTH } from './modules/auth/password';

/** Creates a tenant with its owner. Exported for tests (`env` defaults to the process environment). */
export async function createOwner(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ tenantId: string; userId: string }> {
  const { values } = parseArgs({
    args: argv,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      locale: { type: 'string', default: 'en' },
      'time-zone': { type: 'string', default: 'Europe/Berlin' },
      admin: { type: 'boolean', default: false },
    },
  });
  const password = env.JARVIS_OWNER_PASSWORD ?? '';
  if (!values.email || !values.name) throw new Error('--email and --name are required');
  if (password.length < MIN_PASSWORD_LENGTH)
    throw new Error(`JARVIS_OWNER_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (!['en', 'de', 'ar'].includes(values.locale!))
    throw new Error('--locale must be en, de or ar');

  const config = loadConfig(env);
  const { db } = createDb(config.DATABASE_URL, 1);
  const tenantId = randomUUID();
  const userId = randomUUID();
  const passwordHash = await hashPassword(password);
  try {
    await withContext(db, { tenantId, userId }, async (trx) => {
      // The same rule as PATCH /v1/me: a zone both Node and Postgres understand.
      const timeZone = await canonicalTimeZone(trx, values['time-zone']!);
      if (!timeZone)
        throw new Error(
          `--time-zone ${values['time-zone']} is not a time zone this server can use (try an IANA name such as Europe/Berlin)`,
        );
      await trx
        .insertInto('tenants')
        .values({ id: tenantId, name: `${values.name}` })
        .execute();
      await trx
        .insertInto('users')
        .values({
          id: userId,
          tenant_id: tenantId,
          email: values.email!.toLowerCase(),
          display_name: values.name!,
          password_hash: passwordHash,
          locale: values.locale as 'en' | 'de' | 'ar',
          time_zone: timeZone,
          preferences: JSON.stringify(DEFAULT_PREFERENCES),
        })
        .execute();
      const roles = values.admin ? (['owner', 'platform_admin'] as const) : (['owner'] as const);
      for (const role of roles)
        await trx
          .insertInto('user_roles')
          .values({ tenant_id: tenantId, user_id: userId, role })
          .execute();
      await trx.insertInto('subscriptions').values({ tenant_id: tenantId }).execute();
      await audit(trx, {
        tenantId,
        actorType: 'system',
        actorId: null,
        action: 'account.created',
        targetType: 'user',
        targetId: userId,
        metadata: { roles },
      });
    });
    console.log(
      `Created ${values.admin ? 'owner + platform admin' : 'owner'} ${values.email} (user ${userId}, tenant ${tenantId})`,
    );
    return { tenantId, userId };
  } finally {
    await db.destroy();
  }
}

const commands: Record<string, (argv: string[]) => Promise<unknown>> = {
  'create-owner': createOwner,
};

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const [command, ...rest] = process.argv.slice(2);
  const fn = command ? commands[command] : undefined;
  if (!fn) {
    console.error(`Usage: cli <${Object.keys(commands).join('|')}> [options]`);
    process.exit(1);
  }
  fn(rest).catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
