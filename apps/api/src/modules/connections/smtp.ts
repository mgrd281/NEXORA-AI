import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../../config';
import type { SecretBox } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { assertPublicHost } from '../../lib/net';
import type { ConnectionRow } from '../../db/types';

/** Non-secret SMTP settings, stored in connections.config. */
export interface SmtpConfig {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username?: string;
  fromAddress: string;
  fromName?: string;
}

/** Secret part, stored only inside the AES-GCM envelope. */
export interface SmtpSecret {
  password?: string;
}

const LOCALHOST = new Set(['localhost', '127.0.0.1', '::1']);

/** Socket errors that mean "nothing is listening there", which nodemailer wraps as ESOCKET. */
const UNREACHABLE = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ECONNRESET/;

/** AAD binds a ciphertext to its owner and provider, so rows cannot be swapped. */
export const secretAad = (userId: string, provider: string) => `${userId}:${provider}`;

export function sealSecret(box: SecretBox, userId: string, provider: string, secret: object) {
  return {
    secret_ciphertext: box.seal(JSON.stringify(secret), secretAad(userId, provider)),
    secret_key_id: box.keyId,
  };
}

export function openSecret<T>(
  box: SecretBox,
  row: Pick<ConnectionRow, 'secret_ciphertext' | 'user_id' | 'provider'>,
): T {
  if (!row.secret_ciphertext) return {} as T;
  return JSON.parse(box.open(row.secret_ciphertext, secretAad(row.user_id, row.provider))) as T;
}

/**
 * Builds a transport after validating the destination. Plain-text SMTP is only
 * permitted to localhost when SMTP_ALLOW_INSECURE_LOCALHOST is set (dev/test).
 */
export async function createSmtpTransport(
  cfg: SmtpConfig,
  secret: SmtpSecret,
  config: Config,
): Promise<Transporter> {
  const isLocal = LOCALHOST.has(cfg.host);
  if (cfg.security === 'none' && !(isLocal && config.SMTP_ALLOW_INSECURE_LOCALHOST)) {
    throw new AppError(
      'CONNECTION_FAILED',
      'Unencrypted SMTP is not allowed. Use TLS (port 465) or STARTTLS (port 587).',
    );
  }
  const allowPrivate = new Set(config.fetchAllowPrivateHosts);
  if (isLocal && config.SMTP_ALLOW_INSECURE_LOCALHOST) allowPrivate.add(`${cfg.host}:${cfg.port}`);
  // Connect to the vetted IP but keep the hostname for TLS SNI/certificate validation.
  const address = await assertPublicHost(cfg.host, cfg.port, allowPrivate);
  return nodemailer.createTransport({
    host: address,
    port: cfg.port,
    secure: cfg.security === 'tls',
    requireTLS: cfg.security === 'starttls',
    ignoreTLS: cfg.security === 'none',
    tls: { servername: cfg.host, minVersion: 'TLSv1.2' },
    auth: cfg.username ? { user: cfg.username, pass: secret.password ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/** Opens a session and authenticates without sending anything. */
export async function verifySmtp(
  cfg: SmtpConfig,
  secret: SmtpSecret,
  config: Config,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let transport: Transporter | undefined;
  try {
    transport = await createSmtpTransport(cfg, secret, config);
    await transport.verify();
    return { ok: true };
  } catch (err) {
    const e = err as { code?: string; message?: string; responseCode?: number };
    const msg =
      e instanceof AppError
        ? e.message
        : e.code === 'EAUTH'
          ? 'The mail server rejected the username or password.'
          : e.code === 'ETIMEDOUT' || e.code === 'ECONNECTION' || UNREACHABLE.test(e.message ?? '')
            ? 'Could not reach the mail server. Check host and port.'
            : e.code === 'ESOCKET' || e.code === 'ETLS'
              ? 'Secure connection to the mail server failed. Check the security setting.'
              : 'The mail server could not be verified.';
    return { ok: false, error: msg };
  } finally {
    transport?.close();
  }
}
