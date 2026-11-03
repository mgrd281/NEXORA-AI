import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { pingDb, withContext } from '../db/pool';
import { AppError } from '../lib/errors';
import { resolveSession, SESSION_COOKIE, touchSession } from '../modules/auth/sessions';
import type { AppDeps } from '../services';
import './context';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(
  deps: AppDeps,
  registerRoutes: (app: FastifyInstance, deps: AppDeps) => Promise<void> | void,
): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
                '*.password',
                '*.token',
              ],
              censor: '[redacted]',
            },
          },
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming)
        ? incoming
        : randomUUID();
    },
    // Only private-network load balancers may set X-Forwarded-For.
    trustProxy: config.isProduction ? 'loopback, linklocal, uniquelocal' : false,
    bodyLimit: 256 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    // Run after authentication so limits apply per user (falls back to IP).
    hook: 'preHandler',
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ctx?.userId ?? req.ip,
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
    }),
  });

  app.decorateRequest('ctx', null);

  // Authentication: bearer token (native clients) or httpOnly cookie (web).
  app.addHook('onRequest', async (req) => {
    req.ctx = null;
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    const cookieToken = req.cookies[SESSION_COOKIE];
    const token = bearer ?? cookieToken;
    if (!token) return;
    const s = await resolveSession(deps.db, token);
    if (!s) return;
    const via = bearer ? 'bearer' : 'cookie';
    // CSRF: cookie-authenticated state changes must originate from the web app.
    if (via === 'cookie' && UNSAFE.has(req.method)) {
      const origin = req.headers.origin;
      if (origin !== config.WEB_ORIGIN)
        throw new AppError('FORBIDDEN', 'Cross-site request blocked');
    }
    req.ctx = {
      tenantId: s.tenantId,
      userId: s.userId,
      sessionId: s.sessionId,
      platform: s.platform,
      via,
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    };
    const ctx = req.ctx;
    void withContext(deps.db, ctx, (trx) => touchSession(trx, ctx.sessionId, ctx.userId)).catch(
      (err) => req.log.warn({ err }, 'touch session failed'),
    );
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ err }, err.message);
      return reply.code(err.status).send({
        error: {
          code: err.code,
          message: err.message,
          requestId: req.id,
          ...(err.details ? { details: err.details } : {}),
        },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply
        .code(429)
        .send({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests. Try again shortly.',
            requestId: req.id,
          },
        });
    }
    if (status && status >= 400 && status < 500) {
      const code =
        (err as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE'
          ? 'Request body too large'
          : 'Invalid request';
      return reply
        .code(status)
        .send({ error: { code: 'VALIDATION_FAILED', message: code, requestId: req.id } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send({
        error: {
          code: 'INTERNAL',
          message: 'Something went wrong on our side.',
          requestId: req.id,
        },
      });
  });

  app.setNotFoundHandler((req, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } }),
  );

  // Liveness / readiness (unauthenticated, no data).
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    const db = await pingDb(deps.db);
    return reply.code(db ? 200 : 503).send({ ok: db, database: db });
  });

  await registerRoutes(app, deps);
  return app;
}
