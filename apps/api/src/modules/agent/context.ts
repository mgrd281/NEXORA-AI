/**
 * Per-user runtime context: account, preferences, active connections, AI
 * spend this month, and the model route derived from them. Loaded inside an
 * RLS-scoped transaction.
 */
import type { ConnectionProvider, Preferences } from '@jarvis/contracts';
import { sql } from 'kysely';
import type { Config } from '../../config';
import type { Trx } from '../../db/pool';
import { currentMonth, effectiveTimeZone } from '../../lib/period';
import type { ConnectionRow } from '../../db/types';
import { loadMe } from '../account/me';
import { asLocale } from './i18n';
import { usdToMicro } from './models/pricing';
import { apiKeyConfigured, decideRoute, type ModelRoute } from './models/router';
import type { AccountInfo, ConnectionState } from './tools/types';

export interface AgentContext {
  account: AccountInfo;
  preferences: Preferences;
  /** Active connections only (status 'active', not past expires_at). */
  connections: Map<ConnectionProvider, ConnectionRow>;
  budget: { limitMicro: number; spentMicro: number };
  route: ModelRoute;
  /**
   * Phase C: every non-revoked connection (expired ones included) with its
   * granted capabilities — always set by loadAgentContext; optional only for
   * callers that build a context by hand (tests, evals).
   */
  connectionStates?: ConnectionState[];
  /**
   * Phase C: preferences.spending.monthlyPurchaseLimitUsd and what is
   * committed this calendar month (USD orders: submitting, placed, unknown), in
   * micro-USD. Absent = no purchases allowed (limit 0).
   */
  purchases?: { limitMicro: number; spentMicro: number };
}

/** Phase C: every non-revoked connection as planning and policy see it (no secrets). */
export async function connectionStates(trx: Trx): Promise<ConnectionState[]> {
  const rows = await trx
    .selectFrom('connections')
    .select(['id', 'provider', 'status', 'capabilities', 'account_identifier', 'expires_at'])
    .where('status', '<>', 'revoked')
    .orderBy('provider')
    .orderBy('created_at')
    .execute();
  const now = Date.now();
  return rows.map((r) => ({
    connectionId: r.id,
    provider: r.provider,
    // A row past its expires_at is not usable, whatever its status says.
    status:
      r.status === 'active' && r.expires_at && new Date(r.expires_at).getTime() <= now
        ? 'expired'
        : r.status,
    capabilities: r.capabilities,
    accountIdentifier: r.account_identifier,
  }));
}

/**
 * Phase C: purchases committed in the current calendar month of the user's
 * time zone (the same period as the AI budget), in micro-USD: orders and paid
 * bookings that are in flight, done or unknown (migration 0006). Orders in other
 * currencies are never placed (PURCHASE_CURRENCY), so only USD counts.
 */
export async function monthlyPurchaseSpend(trx: Trx, timeZone: string): Promise<number> {
  const { start } = await currentMonth(trx, timeZone);
  const row = await trx
    .selectFrom('committed_purchases')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('total_micro'), sql<number>`0`).as('total'))
    .where('currency', '=', 'USD')
    .where('created_at', '>=', start)
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

/**
 * Phase C: what `stepId` itself has committed this month (its own order or paid booking), in
 * micro-USD. An acknowledged retry of that step reconciles the row it already wrote, so the
 * policy and the approval's limit bar must not count it against itself.
 */
export async function stepCommittedSpend(
  trx: Trx,
  stepId: string,
  timeZone: string,
): Promise<number> {
  const { start } = await currentMonth(trx, timeZone);
  const row = await trx
    .selectFrom('committed_purchases')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('total_micro'), sql<number>`0`).as('total'))
    .where('currency', '=', 'USD')
    .where('step_id', '=', stepId)
    .where('created_at', '>=', start)
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

/**
 * Model spend of the current user in the current calendar month of their time
 * zone (the budget period shown in Settings → usage). RLS scopes it to the user.
 */
export async function monthlyAiSpend(trx: Trx, timeZone: string): Promise<number> {
  const { start } = await currentMonth(trx, timeZone);
  const row = await trx
    .selectFrom('cost_records')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amount_micro'), sql<number>`0`).as('total'))
    .where('category', '=', 'model')
    .where('created_at', '>=', start)
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

export async function activeConnections(trx: Trx): Promise<Map<ConnectionProvider, ConnectionRow>> {
  const rows = await trx
    .selectFrom('connections')
    .selectAll()
    .where('status', '=', 'active')
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
    .execute();
  return new Map(rows.map((r) => [r.provider, r]));
}

export async function loadAgentContext(
  trx: Trx,
  config: Config,
  userId: string,
): Promise<AgentContext> {
  const me = await loadMe(trx, userId);
  // A stored zone Postgres or Node cannot use (rows from before zones were
  // validated) runs in UTC rather than breaking the budget or the planner.
  const timeZone = await effectiveTimeZone(trx, me.timeZone);
  const [connections, spentMicro, states, purchaseSpent] = await Promise.all([
    activeConnections(trx),
    monthlyAiSpend(trx, timeZone),
    connectionStates(trx),
    monthlyPurchaseSpend(trx, timeZone),
  ]);
  const limitMicro = usdToMicro(me.preferences.spending.monthlyAiBudgetUsd);
  const route = decideRoute({
    apiKeyConfigured: apiKeyConfigured(config),
    allowExternalModels: me.preferences.ai.allowExternalModels,
    budgetMicro: limitMicro,
    spentMicro,
  });
  return {
    account: {
      userId: me.id,
      tenantId: me.tenant.id,
      email: me.email,
      displayName: me.displayName,
      locale: asLocale(me.locale),
      timeZone,
    },
    preferences: me.preferences,
    connections,
    budget: { limitMicro, spentMicro },
    route,
    connectionStates: states,
    purchases: {
      limitMicro: usdToMicro(me.preferences.spending.monthlyPurchaseLimitUsd),
      spentMicro: purchaseSpent,
    },
  };
}

/**
 * Up to `limit` memories relevant to `query` (full-text search, 'simple'
 * configuration, OR across the query's terms, ranked).
 */
export async function relevantMemories(trx: Trx, query: string, limit = 10): Promise<string[]> {
  const rows = await sql<{ content: string }>`
    WITH q AS (
      SELECT to_tsquery('simple', coalesce(array_to_string(ARRAY(
        SELECT quote_literal(l) FROM unnest(tsvector_to_array(to_tsvector('simple', ${query}))) AS l
      ), ' | '), '')) AS query
    )
    SELECT m.content FROM memories m, q
     WHERE q.query::text <> '' AND m.search @@ q.query
     ORDER BY ts_rank(m.search, q.query) DESC, m.updated_at DESC
     LIMIT ${limit}`.execute(trx);
  return rows.rows.map((r) => r.content);
}
