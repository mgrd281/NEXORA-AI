/**
 * The integrations domain's API for other owners (docs/architecture/phase-c.md
 * §4.5): OAuth connections (Google, Microsoft), calendars for Home and the
 * calendar routes, and email watches. Tools of the agent use the modules
 * directly (tokens.ts, mail.ts, calendar.ts); nothing else opens OAuth
 * envelopes.
 */
import type {
  CalendarEventList,
  CalendarEventListQuery,
  ConnectionProviderInfo,
  OAuthCallbackRequest,
  OAuthCallbackResult,
  OAuthStartRequest,
  OAuthStartResponse,
  UpcomingEvents,
} from '@jarvis/contracts';
import type { Config } from '../../config';
import type { DbContext, Trx } from '../../db/pool';
import type { ConnectionRow, EmailWatchRow } from '../../db/types';
import type { RequestContext } from '../../http/context';
import { completeOAuth, providers, startOAuth } from './oauth';
import type { IntegrationDeps } from './types';
import { listEvents, upcomingEvents } from './upcoming';
import { verifyConnection } from './verify';
import { stopWatch, toEmailWatch } from './watches';

export interface IntegrationsApi {
  /** GET /v1/connections/providers: configured or not, capability → scopes, revocation. */
  providers(config: Config): ConnectionProviderInfo[];
  /**
   * POST /v1/connections/oauth/start. Throws AppError: SERVICE_UNAVAILABLE
   * PROVIDER_NOT_CONFIGURED { provider }; VALIDATION_FAILED REDIRECT_URI_NOT_ALLOWED
   * | CONNECTION_NOT_OAUTH; NOT_FOUND (connectionId); RATE_LIMITED OAUTH_PENDING_LIMIT { max }.
   */
  startOAuth(
    deps: IntegrationDeps,
    ctx: RequestContext,
    body: OAuthStartRequest,
  ): Promise<OAuthStartResponse>;
  /**
   * POST /v1/connections/oauth/callback (same session). Throws AppError:
   * VALIDATION_FAILED OAUTH_STATE_INVALID | OAUTH_STATE_EXPIRED | OAUTH_DENIED { provider }
   * | OAUTH_SCOPE_NOT_GRANTED { capabilities }; CONNECTION_FAILED OAUTH_EXCHANGE_FAILED
   * { provider }; CONFLICT OAUTH_ACCOUNT_MISMATCH { provider }.
   */
  completeOAuth(
    deps: IntegrationDeps,
    ctx: RequestContext,
    body: OAuthCallbackRequest,
  ): Promise<OAuthCallbackResult>;
  /** HomeSnapshot.upcoming / GET /v1/calendar/upcoming (null without calendar.read). */
  upcomingEvents(
    deps: IntegrationDeps,
    ctx: DbContext,
    opts?: { timeoutMs?: number; now?: Date },
  ): Promise<UpcomingEvents | null>;
  /**
   * GET /v1/calendar/events. Throws AppError CONNECTION_REQUIRED (409)
   * CALENDAR_NOT_CONNECTED, SERVICE_UNAVAILABLE CALENDAR_UNAVAILABLE { provider },
   * VALIDATION_FAILED for a window over CALENDAR_LIMITS.listMaxDays.
   */
  listEvents(
    deps: IntegrationDeps,
    ctx: DbContext,
    q: CalendarEventListQuery,
  ): Promise<CalendarEventList>;
  /** DELETE /v1/email/watches/:id: status 'stopped' + event; the row as it is now, null if not visible. */
  stopWatch(trx: Trx, ctx: DbContext, watchId: string): Promise<EmailWatchRow | null>;
  /**
   * POST /v1/connections/:id/test (OAuth): asks the provider's identity endpoint with a valid
   * token. Returns the row as it is afterwards: verified now (last_verified_at), or expired
   * (invalid_grant, a refused fresh token, another account). Throws AppError
   * SERVICE_UNAVAILABLE { provider } when the provider does not answer (nothing changed).
   */
  verifyConnection(
    deps: IntegrationDeps,
    ctx: DbContext,
    connectionId: string,
  ): Promise<ConnectionRow>;
}

export const integrations: IntegrationsApi = {
  providers,
  startOAuth,
  completeOAuth,
  upcomingEvents,
  listEvents,
  stopWatch,
  verifyConnection,
};

export { toEmailWatch };
export type { IntegrationDeps };
