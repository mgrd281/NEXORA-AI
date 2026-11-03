# ADR-0007: Authentication — argon2id + opaque sessions, cookie for web, bearer for native

- Status: Accepted
- Date: 2026-11-03

## Context

The private alpha has one owner, but the design must hold for thousands of customers on web, iOS,
Android and macOS. Sessions must be revocable instantly and per device.

## Decision

- **Passwords:** argon2id, `memoryCost 19456 KiB, timeCost 2, parallelism 1` (OWASP minimum),
  `@node-rs/argon2`. Minimum length 12 (enforced by the CLI). Unknown emails still run a full
  verification against a dummy hash so timing does not reveal account existence.
- **Sessions:** 256-bit random opaque tokens (`generateToken`), stored only as SHA-256
  (`sessions.token_hash`). Lifetime `SESSION_TTL_DAYS` (default 30, max 90). Resolved through
  `auth_resolve_session` (checks expiry, revocation and user status on every request).
- **Web:** token in cookie `jarvis_session` — `httpOnly`, `SameSite=Lax`, `Secure` in production,
  `Path=/`. Cookie-authenticated `POST/PUT/PATCH/DELETE` must carry `Origin` equal to `WEB_ORIGIN`
  (CSRF), else 403.
- **Native:** `POST /v1/auth/login` with `platform` ≠ `web` returns the token in the body; apps keep it
  in the Keychain (iOS/macOS) or Keystore (Android) and send `Authorization: Bearer …`. Bearer requests
  carry no ambient credential, so no CSRF check applies.
- **Devices:** `GET /v1/auth/sessions` lists sessions with device name, platform and last use;
  `DELETE /v1/auth/sessions/:id` revokes one; logout revokes the current one.
- **Invitation only:** no sign-up endpoint exists. Accounts are created with the operator CLI
  (`cli create-owner`). The `public_registration` feature flag is seeded `false`.
- **Rate limits:** login 10/min per IP; every login success/failure is audited.

## Alternatives considered

- **JWT access + refresh tokens.** Stateless verification, but revocation needs a denylist anyway and
  tokens leak claims. Opaque tokens are simpler and instantly revocable.
- **bcrypt / scrypt.** argon2id is the current OWASP recommendation.
- **Cookies for native apps.** Awkward on native HTTP stacks and widgets; bearer tokens in the
  Keychain are the platform norm.
- **OIDC-only (no passwords).** Planned as an addition, not a replacement: the owner needs a login that
  works without third-party accounts.

## Consequences

- One indexed lookup per request (`token_hash` is unique). `last_used_at` is written at most every
  5 minutes per session.
- No password reset, password change or MFA in Milestone 1; an operator can reset via the database.
- **Planned before closed beta:** OIDC (Google, Microsoft) and Sign in with Apple (required by App Store
  rules once third-party sign-in exists), passkeys/WebAuthn, MFA for platform admins, invite flow,
  per-account login throttling in addition to per-IP.
