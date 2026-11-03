/**
 * Per-user runtime context: account, preferences, active connections, AI
 * spend this month, and the model route derived from them. Loaded inside an
 * RLS-scoped transaction.
 */
import type { ConnectionProvider, Preferences } from '@jarvis/contracts';
import { sql } from 'kysely';
import type { Config } from '../../config';
import type { Trx } from '../../db/pool';
import type { ConnectionRow } from '../../db/types';
import { loadMe } from '../account/me';
import { asLocale } from './i18n';
import { usdToMicro } from './models/pricing';
import { apiKeyConfigured, decideRoute, type ModelRoute } from './models/router';
import type { AccountInfo } from './tools/types';

export interface AgentContext {
  account: AccountInfo;
  preferences: Preferences;
  connections: Map<ConnectionProvider, ConnectionRow>;
  budget: { limitMicro: number; spentMicro: number };
  route: ModelRoute;
}

/** Start of the current calendar month in UTC (the budget period). */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Model spend of the current user this month (RLS scopes it to the user). */
export async function monthlyAiSpend(trx: Trx, now = new Date()): Promise<number> {
  const row = await trx
    .selectFrom('cost_records')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amount_micro'), sql<number>`0`).as('total'))
    .where('category', '=', 'model')
    .where('created_at', '>=', monthStart(now))
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
  const [connections, spentMicro] = await Promise.all([
    activeConnections(trx),
    monthlyAiSpend(trx),
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
      timeZone: me.timeZone,
    },
    preferences: me.preferences,
    connections,
    budget: { limitMicro, spentMicro },
    route,
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
