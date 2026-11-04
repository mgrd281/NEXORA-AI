/**
 * The boot check (http/route.ts assertAllRoutesRegistered) with the stage-1 exception
 * (Phase C, and Phase D for the telephony routes and webhooks): declared routes without
 * handlers are tolerated outside production only, and only those explicitly listed
 * (src/routes.ts PENDING_ROUTES / PENDING_WEBHOOK_ROUTES).
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  routes,
  telephonyWebhookRoutes,
  type RouteName,
  type TelephonyWebhookName,
} from '@jarvis/contracts';
import { assertAllRoutesRegistered } from '../../../src/http/route';
import { assertAllWebhooksRegistered } from '../../../src/http/webhook-route';
import { PENDING_ROUTES, PENDING_WEBHOOK_ROUTES } from '../../../src/routes';

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

  it('lists only Phase D routes as pending', () => {
    const phaseD = new Set<RouteName>([
      'listCalls',
      'getCall',
      'listDoNotCall',
      'deleteDoNotCall',
      'startPhoneVerification',
      'confirmPhoneVerification',
    ]);
    for (const name of PENDING_ROUTES) {
      expect(ALL.has(name), name).toBe(true);
      expect(phaseD.has(name), name).toBe(true);
    }
  });
});

describe('telephony webhook boot check', () => {
  const ALL_HOOKS = new Set(Object.keys(telephonyWebhookRoutes) as TelephonyWebhookName[]);

  it('fails on any webhook without a handler that is not listed as pending', () => {
    const app = Fastify();
    expect(() => assertAllWebhooksRegistered(app)).toThrow(/Telephony webhooks without handlers/);
    expect(() => assertAllWebhooksRegistered(app, { pending: ALL_HOOKS })).not.toThrow();
    for (const name of PENDING_WEBHOOK_ROUTES) expect(ALL_HOOKS.has(name), name).toBe(true);
  });

  it('never tolerates a pending webhook in production', () => {
    const app = Fastify();
    expect(() =>
      assertAllWebhooksRegistered(app, { pending: ALL_HOOKS, production: true }),
    ).toThrow(/Telephony webhooks without handlers/);
  });
});
