/**
 * The do-not-call list (docs/architecture/phase-d.md §3.5, docs/security/telephony.md §4): a
 * callee who asks not to be called again is honoured at once — an entry for the number on the
 * user's account (source 'callee_request', the call it was said on), and the Policy Engine
 * denies every later call to it (DO_NOT_CALL) at planning and right before dialling.
 *
 * The number itself is never stored in plain here (entries outlive tasks and calls): a keyed
 * HMAC for the check, a masked form for display, and the number sealed with SecretBox
 * (AAD dnc:<user id>:<entry id>) so a key rotation can re-hash it (runbook).
 */
import { randomUUID } from 'node:crypto';
import type { DbContext, Trx } from '../../db/pool';
import type { Config } from '../../config';
import type { SecretBox } from '../../lib/crypto';
import { maskPhoneNumber, regionOfNumber } from '../../lib/phone';
import { numberHash } from './calls';

export const dncAad = (userId: string, id: string) => `dnc:${userId}:${id}`;

/** Adds the number to the user's do-not-call list (once; an existing entry is kept). */
export async function recordDoNotCall(
  trx: Trx,
  ctx: DbContext,
  deps: { config: Pick<Config, 'SECRET_ENCRYPTION_KEY'>; secrets: SecretBox },
  e: { number: string; source: 'callee_request' | 'user'; callId: string | null },
): Promise<{ id: string; created: boolean; masked: string }> {
  const id = randomUUID();
  const masked = maskPhoneNumber(e.number);
  const hash = numberHash(deps.config, e.number);
  const inserted = await trx
    .insertInto('do_not_call')
    .values({
      id,
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      number_hash: hash,
      number_masked: masked,
      number_ciphertext: deps.secrets.seal(e.number, dncAad(ctx.userId, id)),
      number_key_id: deps.secrets.keyId,
      country: regionOfNumber(e.number),
      source: e.source,
      call_session_id: e.callId,
    })
    .onConflict((oc) => oc.columns(['user_id', 'number_hash']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) return { id, created: true, masked };
  const existing = await trx
    .selectFrom('do_not_call')
    .select('id')
    .where('number_hash', '=', hash)
    .executeTakeFirstOrThrow();
  return { id: existing.id, created: false, masked };
}

/** Whether the number is on the user's list (the policy's own check is on AgentContext). */
export async function isOnDoNotCall(
  trx: Trx,
  config: Pick<Config, 'SECRET_ENCRYPTION_KEY'>,
  number: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('do_not_call')
    .select('id')
    .where('number_hash', '=', numberHash(config, number))
    .executeTakeFirst();
  return row !== undefined;
}
