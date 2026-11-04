/** Types of the mock providers (index.mjs), for TypeScript tests. */

export interface MockRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  /** The bearer token's scopes (null: no valid token) and the scopes the endpoint accepts. */
  auth: { scopes: string[] | null; required: string[]; account: string | null } | null;
  status: number;
}

export interface MockAccountInput {
  email: string;
  name?: string;
  sub?: string;
  id?: string;
  timeZone?: string;
}

export interface MockMessageInput {
  id?: string;
  threadId?: string;
  conversationId?: string;
  from: string | { name: string | null; address: string };
  to?: string[];
  cc?: string[];
  replyTo?: string;
  subject?: string;
  body?: string;
  html?: string;
  date?: string | number | Date;
  unread?: boolean;
  labels?: string[];
  folder?: 'inbox' | 'sentitems' | 'drafts';
  headers?: Record<string, string>;
  messageIdHeader?: string;
  internetMessageId?: string;
}

export interface MockEventInput {
  id?: string;
  title: string;
  start: string;
  end: string;
  timeZone?: string;
  originalTimeZone?: string;
  allDay?: boolean;
  attendees?: (string | { email: string; responseStatus?: string })[];
  location?: string;
  description?: string;
  organizer?: string;
  transparency?: 'transparent' | 'opaque';
  showAs?: 'busy' | 'free' | 'tentative' | 'oof';
}

export interface MockResponseSpec {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Wait before answering (slow responses / timeouts). */
  delayMs?: number;
  /** After the delay, answer normally instead of with this spec. */
  passThrough?: boolean;
}

export interface MockOAuthState {
  accessTokenTtlSeconds: number;
  rotateRefreshTokens: boolean;
  grantTypes: { authorization_code: number; refresh_token: number };
  revoked: string[];
  refreshTokens: Map<string, { email: string; clientId: string; scopes: string[]; valid: boolean }>;
  accessTokens: Map<
    string,
    { email: string; clientId: string; scopes: string[]; expiresAt: number; valid: boolean }
  >;
}

export interface MockProvider {
  kind: 'google' | 'microsoft';
  url: string;
  port: number;
  /** The `iss` its authorization responses carry (Google) / its v2.0 issuer (Microsoft). */
  issuer: string;
  requests: MockRequest[];
  oauth: MockOAuthState;
  /** Consent behaviour: deny (error=access_denied) or grant only some of the requested scopes. */
  consent: { deny: boolean; grantOnly: string[] | null; omitScopeInResponse?: boolean };
  /** Invitations, updates, cancellations and mails the provider would have delivered. */
  invitations: { eventId?: string; messageId?: string; to: string; kind: string; from?: string }[];
  addAccount(a: MockAccountInput): void;
  setLoginAccount(email: string): void;
  addMessage(email: string, m: MockMessageInput): string;
  addEvent(email: string, e: MockEventInput): string;
  /** Busy times of someone outside the mock; null = their calendar is not shared. */
  setFreeBusy(email: string, busy: { start: string; end: string }[] | null): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages(email: string): any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sent(email: string): any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  drafts(email: string): any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events(email: string): any[];
  revokeGrants(email: string): void;
  expireAccessTokens(email?: string): void;
  failNext(
    match: { method?: string; path: string | RegExp },
    response: MockResponseSpec,
    times?: number,
  ): void;
  clearFailures(): void;
  errors: {
    invalidToken(): MockResponseSpec;
    insufficientScope(): MockResponseSpec;
    rateLimited(seconds?: number): MockResponseSpec;
    unavailable(status?: number): MockResponseSpec;
  };
  close(): Promise<void>;
}

export interface MockOptions {
  clientId: string;
  clientSecret: string;
  port?: number;
  accounts?: MockAccountInput[];
  accessTokenTtlSeconds?: number;
}

export function startGoogleMock(opts: MockOptions): Promise<MockProvider>;
export function startMicrosoftMock(
  opts: MockOptions & { tenant?: string; rotateRefreshTokens?: boolean },
): Promise<MockProvider>;
export function googleError(status: number, extra?: Record<string, unknown>): MockResponseSpec;
export function graphError(status: number, extra?: Record<string, unknown>): MockResponseSpec;
export const GOOGLE_SCOPES: Record<string, string[]>;
export function pkceChallenge(verifier: string): string;
export function parseRfc822(raw: string): {
  headers: Record<string, string>;
  body: string;
  subject: string;
};
