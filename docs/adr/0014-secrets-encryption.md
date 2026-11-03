# ADR-0014: Connection secrets in AES-256-GCM envelopes with owner-bound AAD

- Status: Accepted
- Date: 2026-11-03

## Context

Connections hold third-party credentials (SMTP passwords today; OAuth tokens in Phase 4). A database
dump, a backup leak or an SQL-level bug must not expose them, and a ciphertext must not be usable for
another user or provider.

## Decision

- **Envelope format** (`SecretBox`, `apps/api/src/lib/crypto.ts`):
  `version (1 byte = 0x01) | IV (12 bytes, random) | GCM tag (16 bytes) | ciphertext`, stored in
  `connections.secret_ciphertext`. The key id (`SECRET_ENCRYPTION_KEY_ID`, default `k1`) is stored next
  to it in `connections.secret_key_id`.
- **AAD** = `"<userId>:<provider>"` (`secretAad`, `modules/connections/smtp.ts`): a ciphertext copied to
  another user's row or another provider fails authentication.
- **Key** = 32 random bytes, base64, from `SECRET_ENCRYPTION_KEY` (validated at boot). In production it
  comes from the platform secret manager, never from the repository or images.
- **Only secrets are encrypted.** Non-secret settings (host, port, sender) live in
  `connections.config`. Secrets and config never leave the server; the API returns only
  `accountIdentifier` (e.g. the sender address). Disconnecting wipes ciphertext, key id and config.
- Logs and audit metadata pass through `redact()`; Fastify's logger redacts `authorization`, `cookie`
  and `set-cookie` headers.

## Rotation

- **Current build (single key):** `SecretBox` holds one key. Rotation = deploy a new key with a new id;
  connections sealed with the old key can no longer be opened and must be re-entered (reconnect SMTP).
  Procedure: [operations runbook](../runbooks/operations.md#rotate-secret_encryption_key).
- **Planned before closed beta:** a keyring (`SECRET_ENCRYPTION_KEYS` with several ids, one marked
  active), decrypt by stored `secret_key_id`, and a re-encryption job that re-seals rows under the active
  key, after which the old key is retired. Then envelope keys from a KMS (data keys per tenant).

## Alternatives considered

- **pgcrypto in the database.** The key would travel to the database and appear in query logs.
- **KMS per secret operation now.** Strong, but adds latency, cost and a cloud dependency to local
  development; planned as the next step.
- **Store OAuth/SMTP credentials with the provider only.** Not possible for SMTP.

## Consequences

- A database leak without the key exposes no credentials; the key must be backed up separately from
  database backups (a restored database without the key has unusable connections).
- Losing the key means every user reconnects their mailbox; no data other than credentials is lost.
