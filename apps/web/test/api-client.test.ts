import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '@/lib/api/client';

const TASK = {
  id: '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f',
  title: 'Remember seat preference',
  request: 'Remember that I prefer aisle seats on flights',
  status: 'QUEUED',
  riskLevel: 'LOW',
  source: 'text',
  progress: { completed: 0, total: 0 },
  pendingApprovalId: null,
  resultSummary: null,
  error: null,
  createdAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-03T10:00:00.000Z',
  completedAt: null,
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('api client', () => {
  it('builds the URL, validates the body, sends the idempotency key and parses the response', async () => {
    const fetch = vi.fn(async () => json(TASK, 202));
    const api = createApiClient({ fetch });
    const task = await api.call('createTask', {
      body: { request: '  Remember that I prefer aisle seats on flights  ' },
      idempotencyKey: 'key-123',
    });
    expect(task.id).toBe(TASK.id);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/tasks');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    const headers = init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('key-123');
    // Trimmed and defaulted by the contract schema.
    expect(JSON.parse(String(init.body))).toEqual({
      request: 'Remember that I prefer aisle seats on flights',
      source: 'text',
    });
  });

  it('substitutes path params and serializes queries with defaults', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ items: [], nextCursor: null }),
    );
    const api = createApiClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
      baseUrl: '/api',
    });
    await api.call('listTasks', { query: { status: 'failed' } });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/tasks?limit=25&status=failed');
  });

  it('does not send an idempotency key to routes that do not take one', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ items: [] }));
    const api = createApiClient({ fetch: fetch as unknown as typeof globalThis.fetch });
    await api.call('listApprovals', { idempotencyKey: 'k' });
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['idempotency-key']).toBeUndefined();
  });

  it('returns undefined for 204 routes', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const api = createApiClient({ fetch });
    await expect(api.call('logout')).resolves.toBeUndefined();
  });

  it('turns API errors into ApiError with code, message and request id', async () => {
    const fetch = vi.fn(async () =>
      json(
        { error: { code: 'APPROVAL_MISMATCH', message: 'Review it again', requestId: 'req-1' } },
        409,
      ),
    );
    const api = createApiClient({ fetch });
    const err = await api
      .call('decideApproval', {
        params: { id: TASK.id },
        body: { decision: 'approve', actionHash: 'sha256:0123456789abcdef' },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'APPROVAL_MISMATCH', status: 409, requestId: 'req-1' });
  });

  it('calls onUnauthenticated for a 401 on an authenticated route only', async () => {
    const onUnauthenticated = vi.fn();
    const unauthorized = () =>
      json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }, 401);
    const api = createApiClient({ fetch: vi.fn(async () => unauthorized()), onUnauthenticated });
    await expect(api.call('getMe')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    await expect(
      api.call('login', { body: { email: 'layla@example.com', password: 'wrong' } }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  it('rejects responses that do not match the contract', async () => {
    const fetch = vi.fn(async () => json({ ...TASK, status: 'DREAMING' }, 202));
    const api = createApiClient({ fetch });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(api.call('createTask', { body: { request: 'x' } })).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });

  it('validates input before sending', async () => {
    const fetch = vi.fn();
    const api = createApiClient({ fetch });
    await expect(api.call('createTask', { body: { request: '   ' } })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 0,
    });
    await expect(api.call('getTask', { params: { id: 'not-a-uuid' } })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps network failures and non-JSON gateway errors to NETWORK', async () => {
    const offline = createApiClient({
      fetch: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    });
    await expect(offline.call('getHome')).rejects.toMatchObject({ code: 'NETWORK', status: 0 });
    const gateway = createApiClient({
      fetch: vi.fn(async () => new Response('Bad gateway', { status: 502 })),
    });
    await expect(gateway.call('getHome')).rejects.toMatchObject({ code: 'NETWORK', status: 502 });
  });
});

describe('redirect to sign-in on 401', () => {
  it('does not report an expired session while a deliberate sign-out is under way', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/tasks', search: '', assign } });
    vi.resetModules();
    const client = await import('@/lib/api/client');
    client.setSigningOut(true);
    client.redirectToSignIn();
    expect(assign).not.toHaveBeenCalled();
    // A failed sign-out leaves the session in place: a later 401 is a real expiry again.
    client.setSigningOut(false);
    client.redirectToSignIn();
    expect(assign).toHaveBeenCalledWith('/sign-in?next=%2Ftasks&reason=expired');
    vi.unstubAllGlobals();
  });
});
