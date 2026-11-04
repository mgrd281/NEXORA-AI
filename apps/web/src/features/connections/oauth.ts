/**
 * Pure helpers for the Google / Microsoft connection cards and the OAuth callback page: which
 * state a card is in, which capabilities to ask for (least privilege, incremental), the exact
 * scopes behind them, and the safety checks on the URLs involved. No React, no I/O —
 * unit-tested in test/phase-c.test.ts.
 */
import type {
  Connection,
  ConnectionCapability,
  ConnectionProviderInfo,
  OAuthCallbackRequest,
  OAuthProvider,
} from '@jarvis/contracts';
import { OAuthCallbackRequest as OAuthCallbackRequestSchema } from '@jarvis/contracts';

export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ['google', 'microsoft'];

/** Capabilities as the card groups them: what JARVIS may do with mail, with the calendar. */
export const CAPABILITY_GROUPS: ReadonlyArray<{
  group: 'mail' | 'calendar';
  capabilities: readonly ConnectionCapability[];
}> = [
  { group: 'mail', capabilities: ['mail.read', 'mail.compose', 'mail.send'] },
  { group: 'calendar', capabilities: ['calendar.read', 'calendar.write'] },
];

/** Preselected on a first connect: reading only (nothing is written or sent without asking). */
export const DEFAULT_CAPABILITIES: readonly ConnectionCapability[] = ['mail.read', 'calendar.read'];

/**
 * Capabilities that need another one to work: changing events re-checks free/busy right before
 * writing (CALENDAR_CONFLICT), which is calendar.read.
 */
export const CAPABILITY_REQUIRES: Partial<Record<ConnectionCapability, ConnectionCapability>> = {
  'calendar.write': 'calendar.read',
};

/** The selection with every capability's prerequisite added, in the provider's order. */
export function withPrerequisites(
  selected: readonly ConnectionCapability[],
  offered: readonly ConnectionCapability[],
): ConnectionCapability[] {
  const set = new Set(selected);
  for (const c of selected) {
    const needed = CAPABILITY_REQUIRES[c];
    if (needed) set.add(needed);
  }
  return offered.filter((c) => set.has(c));
}

/** A capability that is checked because another selected one needs it (shown locked). */
export function requiredBy(
  capability: ConnectionCapability,
  selected: readonly ConnectionCapability[],
): ConnectionCapability | null {
  for (const c of selected) if (CAPABILITY_REQUIRES[c] === capability) return c;
  return null;
}

/** The capabilities this provider offers on this server, in its order. */
export function offeredCapabilities(info: ConnectionProviderInfo): ConnectionCapability[] {
  return info.capabilities.map((c) => c.capability);
}

/**
 * The user's connection for this provider: the one that is not revoked, newest first (the API
 * keeps one per provider; an older client may still see a revoked row until it refreshes).
 */
export function connectionOf(
  provider: OAuthProvider,
  connections: readonly Connection[],
): Connection | null {
  const mine = connections
    .filter((c) => c.provider === provider && c.status !== 'revoked')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return mine[0] ?? null;
}

export type OAuthCardState =
  /** The server has no client id / secret for the provider. */
  | 'unconfigured'
  | 'disconnected'
  | 'active'
  /** Active, but the provider withdrew a permission JARVIS used (403 insufficient scope). */
  | 'scopeMissing'
  /** The grant is gone (invalid_grant, a rejected token): nothing works until reconnected. */
  | 'expired'
  /** Repeated provider failures (5xx); it may recover on its own. */
  | 'error';

export function oauthCardState(
  info: Pick<ConnectionProviderInfo, 'configured'>,
  connection: Pick<Connection, 'status' | 'statusReason'> | null,
): OAuthCardState {
  if (connection) {
    if (connection.status === 'expired') return 'expired';
    if (connection.status === 'error') return 'error';
    if (connection.status === 'active')
      return connection.statusReason === 'SCOPE_MISSING' ? 'scopeMissing' : 'active';
  }
  return info.configured ? 'disconnected' : 'unconfigured';
}

/** What the connection may not do yet: the offered capabilities it was not granted. */
export function missingCapabilities(
  info: ConnectionProviderInfo,
  connection: Pick<Connection, 'capabilities'> | null,
): ConnectionCapability[] {
  const granted = new Set(connection?.capabilities ?? []);
  return offeredCapabilities(info).filter((c) => !granted.has(c));
}

/**
 * What a reconnect asks for: what the connection had (so nothing silently widens or narrows),
 * or the read-only defaults when it has none on record.
 */
export function reconnectCapabilities(
  info: ConnectionProviderInfo,
  connection: Pick<Connection, 'capabilities'> | null,
): ConnectionCapability[] {
  const offered = offeredCapabilities(info);
  const had = (connection?.capabilities ?? []).filter((c) => offered.includes(c));
  return had.length > 0 ? had : DEFAULT_CAPABILITIES.filter((c) => offered.includes(c));
}

/**
 * The exact scopes an authorization asks the provider for: the identity scopes plus each
 * selected capability's scopes (ConnectionProviderInfo, i.e. OAUTH_SCOPES), without repeats.
 */
export function scopesFor(
  info: ConnectionProviderInfo,
  capabilities: readonly ConnectionCapability[],
): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  info.identityScopes.forEach(add);
  for (const c of info.capabilities) if (capabilities.includes(c.capability)) c.scopes.forEach(add);
  return out;
}

/** The scopes behind one capability on this provider. */
export function capabilityScopes(
  info: ConnectionProviderInfo,
  capability: ConnectionCapability,
): readonly string[] {
  return info.capabilities.find((c) => c.capability === capability)?.scopes ?? [];
}

/**
 * The provider's consent page, only when it is an http(s) URL (https outside localhost, where
 * the development mock providers run). Anything else is not followed.
 */
export function safeAuthorizationUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:') return url.href;
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return url.protocol === 'http:' && local ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The provider's redirect as the callback route expects it (its query parameters, verbatim:
 * state + code, or state + error), or null when the page was opened without one.
 */
export function callbackRequest(params: URLSearchParams): OAuthCallbackRequest | null {
  const pick = (name: string) => {
    const v = params.get(name);
    return v === null || v === '' ? undefined : v;
  };
  const candidate = {
    state: pick('state'),
    code: pick('code'),
    error: pick('error'),
    errorDescription: pick('error_description'),
    iss: pick('iss'),
  };
  const parsed = OAuthCallbackRequestSchema.safeParse(
    Object.fromEntries(Object.entries(candidate).filter(([, v]) => v !== undefined)),
  );
  return parsed.success ? parsed.data : null;
}

/** Where to continue after connecting: a path of this app, else Connections. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return '/connections';
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return '/connections';
  return value;
}
