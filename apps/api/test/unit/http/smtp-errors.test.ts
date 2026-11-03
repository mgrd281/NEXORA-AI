import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { verifySmtp } from '../../../src/modules/connections/smtp';
import { testConfig } from '../../integration/helpers';

/** A free port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe('verifySmtp error messages', () => {
  it('reports a refused port as unreachable, not as a TLS problem', async () => {
    const port = await closedPort();
    const r = await verifySmtp(
      { host: '127.0.0.1', port, security: 'none', fromAddress: 'me@example.test' },
      {},
      testConfig(),
    );
    expect(r).toEqual({
      ok: false,
      error: 'Could not reach the mail server. Check host and port.',
    });
  });

  it('refuses unencrypted SMTP to a non-local host', async () => {
    const r = await verifySmtp(
      { host: 'smtp.example.test', port: 587, security: 'none', fromAddress: 'me@example.test' },
      {},
      testConfig(),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Unencrypted SMTP is not allowed/);
  });
});
