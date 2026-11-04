# ADR-0016: OAuth 2.0 connections for Google and Microsoft

- Status: Accepted
- Date: 2026-11-04
- Design: [Phase C architecture](../architecture/phase-c.md) §3.1, §5

## Context

Phase C connects real accounts: Gmail and Google Calendar (Gmail API v1, Calendar API v3) and
Outlook mail and calendar (Microsoft identity platform v2.0 + Microsoft Graph v1.0). JARVIS reads
untrusted mail and invitations, writes drafts and events, and sends mail as the user. Tokens are
long-lived credentials to a person's whole mailbox; the flow that obtains them is the classic target
of login-CSRF, code injection and mix-up attacks, and a refresh that loses a rotated token silently
breaks the connection. There is no real provider in development or CI.

## Decision

- **Authorization code + PKCE (S256), confidential client, server-side exchange.** Both web and iOS
  use the same flow: the client asks `POST /v1/connections/oauth/start` for the authorization URL,
  opens it, and forwards the provider's redirect (its query parameters, verbatim) to
  `POST /v1/connections/oauth/callback` **with its own session**. The callback is never an
  unauthenticated `GET` on the API. iOS uses `ASWebAuthenticationSession` with an `https`
  universal-link callback on the same redirect URI (never a custom scheme for a web client).
- **State bound to the session.** `oauth_states` stores `SHA-256(state)` (32 random bytes,
  base64url), the user, **the session id** (FK, cascades when the session ends), the provider, the
  requested capabilities and scopes, the exact redirect URI and the PKCE verifier sealed with
  SecretBox (AAD `oauth-state:<user>:<id>`). It expires after `OAUTH_LIMITS.stateTtlMinutes` (10; a
  CHECK caps it at 15) and is consumed with `UPDATE … SET consumed_at = now() WHERE consumed_at IS
NULL` (single use). A state from another session or user is `OAUTH_STATE_INVALID`; RLS hides other
  users' rows anyway. At most `maxPendingStates` (5) open requests per user.
- **Exact redirect URIs.** `OAUTH_REDIRECT_URIS` (default `<WEB_ORIGIN>/connections/callback`) is
  matched as a whole string — no prefixes, no wildcards; https only in production. `returnTo` is a
  relative path of the client app (validated by the contract and a DB CHECK) — no open redirect.
- **Mix-up defence.** One state row per provider; when the provider sends an RFC 9207 `iss`, it must
  equal the configured issuer; the token endpoint is the provider's own, never taken from a
  response.
- **Least privilege, incremental.** Capabilities (`mail.read`, `mail.compose`, `mail.send`,
  `calendar.read`, `calendar.write`) map to the scopes frozen in `OAUTH_SCOPES` (contracts): e.g.
  `gmail.readonly`, `gmail.compose`, `gmail.send`, `calendar.events.readonly` +
  `calendar.freebusy`, `calendar.events`; Graph `Mail.Read`, `Mail.ReadWrite` (drafts),
  `Mail.Send`, `Calendars.Read`, `Calendars.ReadWrite` (+ `offline_access`, `User.Read`). Never
  `https://mail.google.com/`, `gmail.modify`, the full `calendar` scope or `.default`. Adding a
  capability later is a new authorization for the new scopes only (`connectionId`; Google
  `include_granted_scopes=true`). The scopes the provider **actually granted** are recorded
  (`granted_scopes`) and a capability is granted only when all of its scopes were (Google's granular
  consent lets users untick some).
- **One account per provider per user**, identified by Google `sub` / Microsoft object id
  (`provider_account_id`). Reconnecting must sign in to the same account
  (`OAUTH_ACCOUNT_MISMATCH` otherwise: disconnect first) — a stolen session cannot silently swap the
  mailbox JARVIS acts on.
- **Tokens at rest.** The token set (access token, refresh token, expiry, scope) is one SecretBox
  envelope in `connections.secret_ciphertext`, AAD `oauth:<user>:<provider>:<connection id>` — no
  separate token table, so every existing guarantee of connection rows (RLS, export without
  secrets, cascade on account deletion) applies unchanged. Access-token expiry is a plain column
  (`token_expires_at`) so refresh needs no decryption to decide. Tokens never appear in logs, job
  payloads, events, notifications, URLs or API responses.
- **Refresh before expiry, single-flight.** A call refreshes when the token expires within
  `refreshSkewSeconds` (300). Concurrent refreshers are serialised by `SELECT … FOR UPDATE` on the
  connection row (across processes) plus an in-process promise per connection; the winner re-reads
  the row after taking the lock, so the losers use its fresh token. Rotation: a response with a new
  `refresh_token` replaces the stored one in the same transaction (Microsoft rotates on every
  refresh; Google rarely does). A lost response is retried with the old refresh token; if that is
  refused, the connection expires (below) — never a silent loop.
- **Expiry and revocation detected, never guessed.** `invalid_grant` on refresh → status `expired`,
  `GRANT_INVALID`; a 401 right after a refresh → `expired`, `TOKEN_REJECTED`; a 403 for missing
  scope → the capability is removed, `SCOPE_MISSING`. Each change notifies once
  (`connection_expired`), emits `connection.changed` and is audited. Steps fail with
  `CONNECTION_REQUIRED` / reason `CONNECTION_EXPIRED` (offer "Reconnect"); the Policy Engine denies
  new steps with `CONNECTION_EXPIRED` before anything runs. After reconnecting, the callback returns
  the recent tasks that failed this way (`resumableTaskIds`) so the client offers Retry — retrying a
  `once_per_step` step that failed definitely (before sending) is safe.
- **Disconnect revokes where the provider allows it.** Deleting a Google connection row (disconnect,
  account deletion, tenant deletion — any path) queues its envelope in `oauth_revocations` through an
  `AFTER DELETE` trigger; the worker drains it via SECURITY DEFINER functions and calls
  `POST https://oauth2.googleapis.com/revoke`. Microsoft has no per-app revocation endpoint
  (`revokeSignInSessions` would end every session of the user, everywhere): JARVIS erases its tokens
  and tells the user where to remove the app's consent (`revocation: 'local_only'`).
- **Mock providers, never in production.** `GOOGLE_BASE_URL_OVERRIDE` / `MICROSOFT_BASE_URL_OVERRIDE`
  point every endpoint path at one local mock origin (`tools/mock-providers`), which implements the
  documented request/response shapes and errors (401 `invalid_token`, 403 insufficient scope, 429
  with `Retry-After`, 5xx, `invalid_grant`, rotation). `loadConfig` refuses them in production.
  Without client id + secret a provider is reported "not configured on this server".

## Alternatives considered

- **Callback as an unauthenticated API `GET`.** Simple for web, but the API then cannot bind the
  state to the session without cookies on the API origin, and iOS bearer sessions could not complete
  it. Rejected for the client-forwarded `POST`.
- **A dedicated `oauth_tokens` table.** Duplicates RLS, export and deletion handling for no gain:
  one active connection has exactly one token set. Rejected.
- **Public client (PKCE only, no secret).** Possible for Microsoft; Google web clients require the
  secret. A confidential server-side client keeps tokens off devices entirely.
- **Proactive background refresh of every connection.** More provider traffic and more tokens in
  flight; refresh on use with a skew covers the need.

## Consequences

- A user has at most one Google and one Microsoft account connected (multiple accounts: later).
- Revoking a Microsoft connection at the provider is the user's step; the UI says so.
- Google's restricted scopes (`gmail.readonly`, `gmail.compose`) require Google's OAuth verification
  and a security assessment before public launch — a release-checklist item, not a code change.
