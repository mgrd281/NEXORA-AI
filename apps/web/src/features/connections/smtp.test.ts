import { describe, expect, it } from 'vitest';
import { changeSecurity, initialDraft, validateDraft, type SmtpDraft } from './smtp';

const account = { email: 'layla.haddad@example.com', displayName: 'Layla Haddad' };

function draft(overrides: Partial<SmtpDraft> = {}): SmtpDraft {
  return { ...initialDraft(account), host: 'smtp.example.com', ...overrides };
}

describe('SMTP form logic', () => {
  it('uses the given (localized) name', () => {
    expect(initialDraft(account, 'E-Mail').label).toBe('E-Mail');
  });

  it('starts with TLS on 465 and the account as sender', () => {
    expect(initialDraft(account)).toMatchObject({
      label: 'Email',
      security: 'tls',
      port: '465',
      fromAddress: 'layla.haddad@example.com',
      fromName: 'Layla Haddad',
    });
  });

  it('moves a default port along with the security mode', () => {
    const starttls = changeSecurity(draft(), 'starttls');
    expect(starttls.port).toBe('587');
    expect(changeSecurity(starttls, 'tls').port).toBe('465');
    expect(changeSecurity(draft({ port: '' }), 'starttls').port).toBe('587');
  });

  it('keeps a port the person typed', () => {
    expect(changeSecurity(draft({ port: '2525' }), 'starttls').port).toBe('2525');
  });

  it('points "none" at a local mailbox when no host was entered', () => {
    const none = changeSecurity(draft({ host: '' }), 'none');
    expect(none).toMatchObject({ security: 'none', host: 'localhost', port: '1025' });
    expect(changeSecurity(draft(), 'none').host).toBe('smtp.example.com');
  });

  it('builds the contract body and omits empty optional fields', () => {
    const result = validateDraft(draft({ username: '  ', password: '', fromName: '' }));
    expect(result).toEqual({
      ok: true,
      body: {
        label: 'Email',
        host: 'smtp.example.com',
        port: 465,
        security: 'tls',
        fromAddress: 'layla.haddad@example.com',
      },
    });
    const full = validateDraft(draft({ username: 'layla', password: 'app pass' }));
    expect(full.ok && full.body).toMatchObject({ username: 'layla', password: 'app pass' });
  });

  it('reports each invalid required field', () => {
    const result = validateDraft(
      draft({ label: ' ', host: '', port: '70000', fromAddress: 'not-an-email' }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.fields.sort()).toEqual(['fromAddress', 'host', 'label', 'port']);
    expect(validateDraft(draft({ port: '12a' })).ok).toBe(false);
  });
});
