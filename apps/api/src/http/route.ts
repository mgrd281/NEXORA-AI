/**
 * Contract-driven route registration. Every handler is bound to an entry of
 * the shared route table (@jarvis/contracts/routes), so path, method, auth
 * level, validation and response shape come from one place.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { routes, type RouteName, type RouteDef } from '@jarvis/contracts';
import type { z } from 'zod';
import { withContext } from '../db/pool';
import { hashObject } from '../lib/crypto';
import { AppError } from '../lib/errors';
import type { AppDeps } from '../services';
import type { RequestContext } from './context';

type Def<N extends RouteName> = (typeof routes)[N];
type Parsed<S> = S extends z.ZodType ? z.output<S> : undefined;

export interface RouteInput<N extends RouteName> {
  params: Def<N> extends { params: infer P } ? Parsed<P> : undefined;
  query: Def<N> extends { query: infer Q } ? Parsed<Q> : undefined;
  body: Def<N> extends { body: infer B } ? Parsed<B> : undefined;
  /** Present on every route whose auth is not 'none'. */
  ctx: RequestContext;
  req: FastifyRequest;
  reply: FastifyReply;
  idempotencyKey: string | undefined;
}

type Result<N extends RouteName> = Def<N>['response'] extends z.ZodType
  ? z.input<Def<N>['response']>
  : void;

const registered = new WeakMap<FastifyInstance, Set<RouteName>>();

function parse<S extends z.ZodType>(schema: S | undefined, value: unknown, where: string): unknown {
  if (!schema) return undefined;
  const r = schema.safeParse(value ?? (where === 'body' ? undefined : {}));
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', `Invalid ${where}`, {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export function defineRoute<N extends RouteName>(
  app: FastifyInstance,
  deps: AppDeps,
  name: N,
  handler: (input: RouteInput<N>) => Promise<Result<N>>,
  options: { rateLimit?: { max: number; timeWindow: string } } = {},
): void {
  const def = routes[name] as RouteDef;
  const set = registered.get(app) ?? new Set();
  set.add(name);
  registered.set(app, set);

  app.route({
    method: def.method,
    url: def.path,
    config: { routeName: name, ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}) },
    handler: async (req, reply) => {
      const ctx = req.ctx;
      if (def.auth !== 'none' && !ctx) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
      if (def.auth === 'platform_admin') {
        const r = await sql<{
          roles: string[];
        }>`select auth_user_roles(${ctx!.userId}) as roles`.execute(deps.db);
        if (!r.rows[0]?.roles.includes('platform_admin'))
          throw new AppError('FORBIDDEN', 'Administrator access required');
      }
      const params = parse(def.params, req.params, 'path parameters');
      const query = parse(def.query, req.query, 'query');
      const body = parse(def.body, req.body, 'body');

      const rawKey = req.headers['idempotency-key'];
      const idempotencyKey = def.idempotent && typeof rawKey === 'string' ? rawKey : undefined;
      if (
        idempotencyKey !== undefined &&
        (idempotencyKey.length < 8 || idempotencyKey.length > 128)
      ) {
        throw new AppError('VALIDATION_FAILED', 'Idempotency-Key must be 8–128 characters');
      }

      const run = async () => {
        const out = await handler({
          params,
          query,
          body,
          ctx: ctx!,
          req,
          reply,
          idempotencyKey,
        } as RouteInput<N>);
        if (def.response === null) return undefined;
        const checked = def.response.safeParse(out);
        if (!checked.success) {
          req.log.error(
            { route: name, issues: checked.error.issues.slice(0, 5) },
            'response contract violation',
          );
          if (!deps.config.isProduction)
            throw new AppError('INTERNAL', `Response for ${name} violates its contract`);
          return out;
        }
        return checked.data;
      };

      let result: unknown;
      if (idempotencyKey && ctx) {
        result = await withIdempotency(deps, ctx, name, idempotencyKey, { params, body }, run);
      } else {
        result = await run();
      }

      if (def.response === null) return reply.code(204).send();
      return reply.code(def.successStatus ?? 200).send(result);
    },
  });
}

/**
 * Replays the stored response for a repeated Idempotency-Key, rejects reuse of
 * a key with a different request, and reports a concurrent duplicate as CONFLICT.
 */
async function withIdempotency(
  deps: AppDeps,
  ctx: RequestContext,
  route: string,
  key: string,
  request: unknown,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const requestHash = hashObject(request);
  const claimed = await withContext(deps.db, ctx, async (trx) => {
    const existing = await trx
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('user_id', '=', ctx.userId)
      .where('route', '=', route)
      .where('key', '=', key)
      .executeTakeFirst();
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new AppError(
          'IDEMPOTENCY_MISMATCH',
          'This Idempotency-Key was used for a different request',
        );
      }
      if (existing.response_status === null)
        throw new AppError('CONFLICT', 'An identical request is still in progress');
      return { replay: existing.response_body };
    }
    await trx
      .insertInto('idempotency_keys')
      .values({
        user_id: ctx.userId,
        tenant_id: ctx.tenantId,
        route,
        key,
        request_hash: requestHash,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    return null;
  });
  if (claimed) return claimed.replay;
  try {
    const result = await run();
    await withContext(deps.db, ctx, (trx) =>
      trx
        .updateTable('idempotency_keys')
        .set({ response_status: 200, response_body: JSON.stringify(result ?? null) })
        .where('user_id', '=', ctx.userId)
        .where('route', '=', route)
        .where('key', '=', key)
        .execute(),
    );
    return result;
  } catch (err) {
    // Release the key so the client can retry after a failure.
    await withContext(deps.db, ctx, (trx) =>
      trx
        .deleteFrom('idempotency_keys')
        .where('user_id', '=', ctx.userId)
        .where('route', '=', route)
        .where('key', '=', key)
        .execute(),
    ).catch(() => undefined);
    throw err;
  }
}

/** Throws at boot if any route in the contract table has no handler. */
export function assertAllRoutesRegistered(app: FastifyInstance): void {
  const set = registered.get(app) ?? new Set();
  const missing = (Object.keys(routes) as RouteName[]).filter((n) => !set.has(n));
  if (missing.length) throw new Error(`Routes without handlers: ${missing.join(', ')}`);
}

declare module 'fastify' {
  interface FastifyContextConfig {
    routeName?: string;
  }
}
