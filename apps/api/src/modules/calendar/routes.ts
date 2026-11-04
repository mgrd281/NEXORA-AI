/**
 * Calendar read routes (docs/architecture/phase-c.md §3.3): thin over the
 * integrations module, which reads every connection granting calendar.read
 * live from the provider (nothing is stored; the only cache is Home's
 * in-memory one). `upcoming` is null when no connection grants calendar.read.
 */
import type { FastifyInstance } from 'fastify';
import { CALENDAR_LIMITS } from '@jarvis/contracts';
import { defineRoute } from '../../http/route';
import type { AppDeps } from '../../services';
import { integrations } from '../integrations';

export function registerCalendarRoutes(app: FastifyInstance, deps: AppDeps) {
  defineRoute(app, deps, 'listUpcomingEvents', async ({ ctx, reply }) => {
    const upcoming = await integrations.upcomingEvents(deps, ctx, {
      timeoutMs: CALENDAR_LIMITS.homeTimeoutMs,
    });
    // Other people's invitations: never kept by shared caches.
    reply.header('cache-control', 'private, no-store');
    return { upcoming };
  });

  defineRoute(
    app,
    deps,
    'listCalendarEvents',
    async ({ ctx, query, reply }) => {
      // Throws CONNECTION_REQUIRED (409) CALENDAR_NOT_CONNECTED, SERVICE_UNAVAILABLE (503)
      // CALENDAR_UNAVAILABLE { provider }, VALIDATION_FAILED for a window over listMaxDays.
      const list = await integrations.listEvents(deps, ctx, query);
      reply.header('cache-control', 'private, no-store');
      return list;
    },
    // Each call reaches every connected provider.
    { rateLimit: { max: 60, timeWindow: '1 minute' } },
  );
}
