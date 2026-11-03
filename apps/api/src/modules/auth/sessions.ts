import { sql } from 'kysely';
import type { Platform } from '@jarvis/contracts';
import type { Db, Trx } from '../../db/pool';
import { generateToken, sha256 } from '../../lib/crypto';

export const SESSION_COOKIE = 'jarvis_session';

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  tenantId: string;
  expiresAt: Date;
  platform: Platform;
}

export async function createSession(
  trx: Trx,
  input: {
    tenantId: string;
    userId: string;
    platform: Platform;
    deviceName?: string | null;
    userAgent?: string | null;
    ttlDays: number;
  },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + input.ttlDays * 86_400_000);
  const row = await trx
    .insertInto('sessions')
    .values({
      tenant_id: input.tenantId,
      user_id: input.userId,
      token_hash: sha256(token),
      platform: input.platform,
      device_name: input.deviceName ?? null,
      user_agent: input.userAgent ? input.userAgent.slice(0, 300) : null,
      expires_at: expiresAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, token, expiresAt };
}

/** Resolves a bearer token via the SECURITY DEFINER lookup (sessions are cross-tenant by nature). */
export async function resolveSession(db: Db, token: string): Promise<ResolvedSession | null> {
  if (!token || token.length > 128) return null;
  const res = await sql<{
    session_id: string;
    user_id: string;
    tenant_id: string;
    expires_at: Date;
    platform: Platform;
  }>`select * from auth_resolve_session(${sha256(token)})`.execute(db);
  const r = res.rows[0];
  return r
    ? {
        sessionId: r.session_id,
        userId: r.user_id,
        tenantId: r.tenant_id,
        expiresAt: r.expires_at,
        platform: r.platform,
      }
    : null;
}

/** Updates last-used timestamps at most once per 5 minutes per session. */
export async function touchSession(trx: Trx, sessionId: string, userId: string): Promise<void> {
  await trx
    .updateTable('sessions')
    .set({ last_used_at: sql`now()` as unknown as Date })
    .where('id', '=', sessionId)
    .where('last_used_at', '<', sql<Date>`now() - interval '5 minutes'`)
    .execute();
  await trx
    .updateTable('users')
    .set({ last_active_at: sql`now()` as unknown as Date })
    .where('id', '=', userId)
    .where((eb) =>
      eb.or([
        eb('last_active_at', 'is', null),
        eb('last_active_at', '<', sql<Date>`now() - interval '5 minutes'`),
      ]),
    )
    .execute();
}
