/**
 * The boot check (http/route.ts assertAllRoutesRegistered) with the Phase C
 * stage-1 exception: declared routes without handlers are tolerated outside
 * production only, and only those explicitly listed (src/routes.ts PENDING_ROUTES).
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { routes, type RouteName } from '@jarvis/contracts';
import { assertAllRoutesRegistered } from '../../../src/http/route';
import { PENDING_ROUTES } from '../../../src/routes';

const ALL = new Set(Object.keys(routes) as RouteName[]);

describe('route boot check', () => {
  it('fails on any route without a handler that is not listed as pending', () => {
    const app = Fastify();
    expect(() => assertAllRoutesRegistered(app)).toThrow(/Routes without handlers/);
    expect(() => assertAllRoutesRegistered(app, { pending: PENDING_ROUTES })).toThrow(
      /Routes without handlers: login/,
    );
    expect(() => assertAllRoutesRegistered(app, { pending: ALL })).not.toThrow();
  });

  it('never tolerates a pending route in production', () => {
    const app = Fastify();
    expect(() => assertAllRoutesRegistered(app, { pending: ALL, production: true })).toThrow(
      /Routes without handlers/,
    );
  });

  it('lists only Phase C routes as pending', () => {
    for (const name of PENDING_ROUTES) expect(ALL.has(name), name).toBe(true);
    expect(PENDING_ROUTES.size).toBeLessThanOrEqual(13);
  });
});
