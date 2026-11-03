import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { pingDb, withContext } from '../db/pool';
import { AppError } from '../lib/errors';
import { resolveSession, SESSION_COOKIE, touchSession } from '../modules/auth/sessions';
import type { AppDeps } from '../services';
import './context';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Postgres errors that only client data can cause once input has passed the
 * contracts: invalid byte sequence (22021, e.g. U+0000 in text), untranslatable
 * character (22P05, e.g. \u0000 in jsonb) and date/time field overflow (22008).
 */
const CLIENT_DATA_ERRORS = new Set(['22021', '22P05', '22008']);

/** The session token a request carries: bearer header (native clients) or httpOnly cookie (web). */
export function sessionToken(
  req: Pick<FastifyRequest, 'headers' | 'cookies'>,
): { token: string; via: 'bearer' | 'cookie' } | null {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  if (bearer) return { token: bearer, via: 'bearer' };
  const cookieToken = req.cookies[SESSION_COOKIE];
  return cookieToken ? { token: cookieToken, via: 'cookie' } : null;
}

/**
 * Path of the first string (value or object key) containing U+0000, or null.
 * Postgres text and jsonb cannot store it. Iterative, so deeply nested JSON
 * cannot exhaust the stack.
 */
export function findNul(value: unknown): string | null {
  const stack: [unknown, string][] = [[value, '']];
  const at = (path: string, key: string) => (path ? `${path}.${key}` : key);
  while (stack.length > 0) {
    const [v, path] = stack.pop()!;
    if (typeof v === 'string') {
      if (v.includes('\u0000')) return path;
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => stack.push([item, at(path, String(i))]));
    } else if (v !== null && typeof v === 'object') {
      for (const [key, item] of Object.entries(v)) {
        if (key.includes('\u0000')) return at(path, key.replaceAll('\u0000', '\\u0000'));
        stack.push([item, at(path, key)]);
      }
    }
  }
  return null;
}

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

  // Body-less actions (cancel, enable web access, logout, …) sent with a JSON content type
  // would otherwise fail Fastify's empty-JSON-body check; treat them as having no body.
  app.addHook('onRequest', async (req) => {
    if (req.headers['content-length'] === '0' && req.headers['content-type']?.includes('json')) {
      delete req.headers['content-type'];
    }
  });

  // Authentication: bearer token (native clients) or httpOnly cookie (web).
  app.addHook('onRequest', async (req) => {
    req.ctx = null;
    const presented = sessionToken(req);
    if (!presented) return;
    const s = await resolveSession(deps.db, presented.token);
    if (!s) return;
    const { via } = presented;
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

  // Text Postgres cannot store is a client error, checked once for every route
  // before its contract validation: path parameters, query string and body.
  app.addHook('preValidation', async (req) => {
    const parts = [
      ['path parameters', req.params],
      ['query', req.query],
      ['body', req.body],
    ] as const;
    for (const [where, value] of parts) {
      const path = findNul(value);
      if (path !== null)
        throw new AppError('VALIDATION_FAILED', `Invalid ${where}`, {
          issues: [{ path, message: 'Text must not contain NUL (U+0000) characters' }],
        });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof pg.DatabaseError && err.code && CLIENT_DATA_ERRORS.has(err.code)) {
      req.log.warn({ err }, 'database rejected request data');
      return reply.code(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'Invalid request', requestId: req.id },
      });
    }
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
      return reply.code(429).send({
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
    return reply.code(500).send({
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
