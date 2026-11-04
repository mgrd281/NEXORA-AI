/** Shared types of the integrations domain (docs/architecture/phase-c.md §2, owner: integrations). */
import type { ConnectionCapability, OAuthProvider } from '@jarvis/contracts';
import type { Config } from '../../config';
import type { Db } from '../../db/pool';
import type { SecretBox } from '../../lib/crypto';

/** What every integrations function needs (AppDeps and RuntimeDeps both have it). */
export interface IntegrationDeps {
  config: Config;
  db: Db;
  secrets: SecretBox;
}

/**
 * The token set of one OAuth connection, sealed as ONE SecretBox envelope in
 * connections.secret_ciphertext (AAD oauth:<user>:<provider>:<connection id>).
 * Never logged, never in job payloads, events, notifications or responses.
 */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** ISO instant the access token expires. */
  expiresAt: string;
  /** The scopes the provider reported for this token set. */
  scope: string[];
  tokenType: string;
}

/** The parts of a connection row the provider clients use. */
export interface ConnectionRef {
  id: string;
  provider: OAuthProvider;
  /** The account's address (sender / calendar owner). */
  accountIdentifier: string | null;
}

export type { ConnectionCapability, OAuthProvider };

export const PROVIDER_NAME: Record<OAuthProvider, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
};

export const isOAuthProvider = (p: string): p is OAuthProvider =>
  p === 'google' || p === 'microsoft';
