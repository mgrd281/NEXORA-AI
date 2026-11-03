import { DEFAULT_PREFERENCES, Preferences, type Me, type Role } from '@jarvis/contracts';
import type { Trx } from '../../db/pool';
import { notFound } from '../../lib/errors';

/** Deep-merge stored preferences over defaults so new preference keys get sane values. */
export function resolvePreferences(stored: unknown): Preferences {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<
    string,
    Record<string, unknown>
  >;
  const merged = Object.fromEntries(
    Object.entries(DEFAULT_PREFERENCES).map(([k, v]) => [k, { ...v, ...(s[k] ?? {}) }]),
  );
  const parsed = Preferences.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_PREFERENCES;
}

export async function loadMe(trx: Trx, userId: string): Promise<Me> {
  const u = await trx
    .selectFrom('users as u')
    .innerJoin('tenants as t', 't.id', 'u.tenant_id')
    .select([
      'u.id',
      'u.email',
      'u.display_name',
      'u.locale',
      'u.time_zone',
      'u.theme',
      'u.preferences',
      'u.created_at',
      't.id as tenant_id',
      't.name as tenant_name',
    ])
    .where('u.id', '=', userId)
    .executeTakeFirst();
  if (!u) throw notFound('User');
  const roles = await trx
    .selectFrom('user_roles')
    .select('role')
    .where('user_id', '=', userId)
    .execute();
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    locale: u.locale,
    timeZone: u.time_zone,
    theme: u.theme,
    roles: roles.map((r) => r.role as Role),
    tenant: { id: u.tenant_id, name: u.tenant_name },
    preferences: resolvePreferences(u.preferences),
    createdAt: u.created_at.toISOString(),
  };
}
