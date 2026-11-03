import type { Platform } from '@jarvis/contracts';
import type { DbContext } from '../db/pool';

/** Authenticated identity attached to every request that passed the auth hook. */
export interface RequestContext extends DbContext {
  sessionId: string;
  platform: Platform;
  /** How the request authenticated; cookie requests get CSRF (Origin) checks. */
  via: 'cookie' | 'bearer';
  requestId: string;
  ip: string;
  userAgent: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext | null;
  }
}
