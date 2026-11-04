/**
 * Sentry on (a capturing transport instead of the network): 5xx errors are
 * reported with bounded tags only, and nothing personal or content-like
 * leaves — request bodies, cookies, headers, query strings, addresses, links.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureException, errorsEnabled } from '../../../src/observability';
import { startSentry, stopSentry } from '../../../src/observability/sentry';
import { fakeDb, obsConfig, testApp } from './support';

const sent: string[] = [];
const transport = () => ({
  send: async (envelope: unknown) => {
    sent.push(JSON.stringify(envelope));
    return {};
  },
  flush: async () => true,
});

const config = obsConfig({ SENTRY_DSN: 'https://public@o0.ingest.sentry.invalid/1' });

async function flushed(): Promise<string> {
  const S = await import('@sentry/node');
  await S.flush(2_000);
  return sent.join('\n');
}

beforeAll(async () => {
  await startSentry(config, 'api', { transport });
});
afterAll(() => stopSentry());
beforeEach(() => {
  sent.length = 0;
});

describe('captureException', () => {
  it('sends the error with bounded tags only, its message scrubbed', async () => {
    expect(errorsEnabled()).toBe(true);
    captureException(
      new Error('SMTP rejected anna@example.com via https://smtp.example.com/?token=abc'),
      {
        requestId: 'req-1234abcd',
        route: 'createTask',
        jobId: 12,
        jobKind: 'task.execute',
      },
    );
    const out = await flushed();
    expect(out).toContain('"jarvis.route":"createTask"');
    expect(out).toContain('"jarvis.request_id":"req-1234abcd"');
    expect(out).toContain('"jarvis.job_kind":"task.execute"');
    expect(out).toContain('"service":"api"');
    expect(out).toContain('SMTP rejected [email] via [url]');
    expect(out).not.toMatch(/anna@|smtp\.example\.com|token=abc/);
  });
});

describe('the API error handler', () => {
  let app: Awaited<ReturnType<typeof testApp>>;
  beforeAll(async () => {
    app = await testApp(config, { db: fakeDb().db });
  });
  afterAll(() => app.close());

  it('reports 5xx with route and request id, without request data', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/boom?q=my+private+search',
      headers: {
        authorization: 'Bearer session-token-value',
        cookie: 'jarvis_session=abc',
        'user-agent': 'Secret-Agent/1.0',
        'x-request-id': 'req-boom-0001',
      },
    });
    expect(res.statusCode).toBe(500);
    const out = await flushed();
    expect(out).toContain('"jarvis.route":"boom"');
    expect(out).toContain('"jarvis.request_id":"req-boom-0001"');
    expect(out).toContain('boom for [email] at [url]');
    expect(out).not.toMatch(
      /private|session-token-value|jarvis_session|Secret-Agent|someone@example\.com|secret\.example/,
    );
  });

  it('does not report client errors', async () => {
    await app.inject({ url: '/v1/nowhere' });
    expect(await flushed()).toBe('');
  });
});
