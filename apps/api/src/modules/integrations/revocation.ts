/**
 * Token revocation drain (docs/adr/0016): deleting a Google connection row —
 * on any path — queues its envelope in oauth_revocations (AFTER DELETE
 * trigger). The worker claims due rows through SECURITY DEFINER functions
 * (no table grants), opens each envelope with the connection's own AAD, and
 * POSTs the refresh token (else the access token) to Google's revocation
 * endpoint. 200, or 400 invalid_token (already revoked), completes it; other
 * failures back off (up to a day); after REVOCATION_MAX_ATTEMPTS the row is
 * completed anyway and the abandonment audited. Microsoft has no per-app
 * revocation endpoint: nothing is queued for it.
 */
import { sql } from 'kysely';
import { audit } from '../audit/audit';
import { OAUTH_ADAPTERS } from './oauth-client';
import { providerSignal } from './signal';
import { oauthAad } from './tokens';
import type { IntegrationDeps, TokenSet } from './types';

export const REVOCATION_MAX_ATTEMPTS = 12;
/** A claimed row is due again after this lease if the worker dies mid-way. */
export const REVOCATION_LEASE_SECONDS = 300;

interface Claimed {
  id: number;
  provider: string;
  user_id: string;
  connection_id: string;
  token_ciphertext: Buffer;
  token_key_id: string;
  attempts: number;
}

async function revokeOne(deps: IntegrationDeps, r: Claimed): Promise<'done' | string> {
  if (r.provider !== 'google') return 'done';
  const url = deps.config.oauth.google ? OAUTH_ADAPTERS.google.revokeUrl(deps.config) : null;
  if (!url) return 'google_not_configured';
  let tokens: TokenSet;
  try {
    tokens = JSON.parse(
      deps.secrets.open(r.token_ciphertext, oauthAad(r.user_id, 'google', r.connection_id)),
    ) as TokenSet;
  } catch {
    return 'envelope_unreadable';
  }
  const token = tokens.refreshToken ?? tokens.accessToken;
  if (!token) return 'done';
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: providerSignal(),
      redirect: 'error',
    });
  } catch {
    return 'network';
  }
  if (res.ok) return 'done';
  let error = `http_${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') error = body.error;
  } catch {
    // not JSON
  }
  // Already revoked or expired at Google: nothing left to revoke.
  if (res.status === 400 && error === 'invalid_token') return 'done';
  return error;
}

/** One round of the drain timer; returns how many rows it finished. */
export async function drainRevocations(deps: IntegrationDeps, limit = 100): Promise<number> {
  const claimed = await sql<Claimed>`
    SELECT * FROM oauth_revocations_claim(${limit}, ${REVOCATION_LEASE_SECONDS})`.execute(deps.db);
  const done: number[] = [];
  for (const r of claimed.rows) {
    const outcome = await revokeOne(deps, r);
    if (outcome === 'done') {
      done.push(Number(r.id));
      continue;
    }
    if (r.attempts >= REVOCATION_MAX_ATTEMPTS) {
      done.push(Number(r.id));
      await audit(deps.db, {
        tenantId: null,
        actorType: 'system',
        actorId: null,
        action: 'connection.revocation_abandoned',
        targetType: 'connection',
        targetId: r.connection_id,
        metadata: { provider: r.provider, attempts: r.attempts, error: outcome },
      });
      continue;
    }
    await sql`SELECT oauth_revocations_failed(${Number(r.id)}::bigint, ${outcome})`.execute(
      deps.db,
    );
  }
  if (done.length) await sql`SELECT oauth_revocations_complete(${done}::bigint[])`.execute(deps.db);
  return done.length;
}

/** The OAuth state purge timer (expired or used authorization requests). */
export async function purgeOAuthStates(deps: Pick<IntegrationDeps, 'db'>): Promise<number> {
  const res = await sql<{ n: number }>`SELECT oauth_states_purge() AS n`.execute(deps.db);
  return Number(res.rows[0]?.n ?? 0);
}
