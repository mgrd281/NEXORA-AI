import type { FastifyInstance } from 'fastify';
import { assertAllRoutesRegistered } from './http/route';
import { registerAuthRoutes } from './modules/auth/routes';
import type { AppDeps } from './services';

/**
 * Registers every HTTP module. Boot fails if any route in the contract table
 * lacks a handler, so the API can never silently ship a dead endpoint.
 */
export async function registerRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  registerAuthRoutes(app, deps);
  // Other modules are registered here (tasks, approvals, home, connections, memory,
  // notifications, account, voice, admin, events stream).
  assertAllRoutesRegistered(app);
}
