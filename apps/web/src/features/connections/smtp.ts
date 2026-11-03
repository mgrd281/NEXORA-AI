import { CreateSmtpConnectionRequest } from '@jarvis/contracts';

export type SmtpSecurity = 'tls' | 'starttls' | 'none';

/** The standard port for each security mode (1025 is the usual local development mailbox). */
export const DEFAULT_PORT: Record<SmtpSecurity, number> = { tls: 465, starttls: 587, none: 1025 };

export interface SmtpDraft {
  label: string;
  host: string;
  port: string;
  security: SmtpSecurity;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
}

export type SmtpField = 'label' | 'host' | 'port' | 'fromAddress';

export function initialDraft(
  account: { email: string; displayName: string },
  label = 'Email',
): SmtpDraft {
  return {
    label,
    host: '',
    port: String(DEFAULT_PORT.tls),
    security: 'tls',
    username: '',
    password: '',
    fromAddress: account.email,
    fromName: account.displayName,
  };
}

/**
 * Switching security moves the port to the new mode's standard port, unless the person typed
 * a port of their own. "None" is for a mailbox on this machine, so an empty host becomes
 * localhost.
 */
export function changeSecurity(draft: SmtpDraft, security: SmtpSecurity): SmtpDraft {
  const port = draft.port.trim();
  const portIsDefault = port === '' || port === String(DEFAULT_PORT[draft.security]);
  return {
    ...draft,
    security,
    port: portIsDefault ? String(DEFAULT_PORT[security]) : draft.port,
    host: security === 'none' && draft.host.trim() === '' ? 'localhost' : draft.host,
  };
}

export type SmtpValidation =
  { ok: true; body: CreateSmtpConnectionRequest } | { ok: false; fields: SmtpField[] };

/** Validates the draft with the contract's own schema; optional fields are omitted when empty. */
export function validateDraft(draft: SmtpDraft): SmtpValidation {
  const port = /^\d{1,5}$/.test(draft.port.trim()) ? Number(draft.port.trim()) : Number.NaN;
  const candidate = {
    label: draft.label,
    host: draft.host,
    port,
    security: draft.security,
    fromAddress: draft.fromAddress.trim(),
    ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
    ...(draft.password ? { password: draft.password } : {}),
    ...(draft.fromName.trim() ? { fromName: draft.fromName } : {}),
  };
  const parsed = CreateSmtpConnectionRequest.safeParse(candidate);
  if (parsed.success) return { ok: true, body: parsed.data };
  const fields = new Set<SmtpField>();
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (key === 'label' || key === 'host' || key === 'port' || key === 'fromAddress') {
      fields.add(key);
    }
  }
  // Other fields have maxLength in the form, so their limits cannot be exceeded there.
  return { ok: false, fields: [...fields] };
}
