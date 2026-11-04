import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPath, EVENTS_PATH, routes, type RouteDef, type RouteName } from '@jarvis/contracts';
import { PENDING_ROUTES } from '../../../src/routes';
import { createHarness, type Harness } from './support';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const SOME_ID = '00000000-0000-4000-8000-000000000000';

describe('route registration', () => {
  it('registers every contract route and rejects unauthenticated calls to protected ones', async () => {
    // Phase C stage 1: routes whose handlers land in stage 2 are checked below instead.
    const protectedRoutes = (Object.entries(routes) as [RouteName, RouteDef][]).filter(
      ([name, r]) => r.auth !== 'none' && !PENDING_ROUTES.has(name),
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

  it('answers 404 for contract routes whose handlers have not landed (never a placeholder)', async () => {
    for (const name of PENDING_ROUTES) {
      const r = routes[name] as RouteDef;
      const url = buildPath(r.path, { id: SOME_ID });
      const res = await h.app.inject({ method: r.method, url });
      expect(res.statusCode, `${name} ${r.method} ${url}`).toBe(404);
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
