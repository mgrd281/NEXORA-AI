import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPath, EVENTS_PATH, routes, type RouteDef } from '@jarvis/contracts';
import { createHarness, type Harness } from './support';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const SOME_ID = '00000000-0000-4000-8000-000000000000';

describe('route registration', () => {
  it('registers every contract route and rejects unauthenticated calls to protected ones', async () => {
    const protectedRoutes = (Object.entries(routes) as [string, RouteDef][]).filter(
      ([, r]) => r.auth !== 'none',
    );
    expect(protectedRoutes.length).toBeGreaterThan(30);
    for (const [name, r] of protectedRoutes) {
      const url = buildPath(r.path, { id: SOME_ID });
      const res = await h.app.inject({
        method: r.method,
        url,
        ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${name} ${r.method} ${url}`).toBe(401);
      expect(res.json().error.code, name).toBe('UNAUTHENTICATED');
    }
  });

  it('serves the SSE endpoint outside the route table', async () => {
    const res = await h.app.inject({ method: 'GET', url: EVENTS_PATH });
    expect(res.statusCode).toBe(401);
  });

  it('answers unknown routes with the API error shape', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
