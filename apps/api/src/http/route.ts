/**
 * Contract-driven route registration. Every handler is bound to an entry of
 * the shared route table (@jarvis/contracts/routes), so path, method, auth
 * level, validation and response shape come from one place.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
        result = await withIdempotency(
          deps,
          ctx,
          req.log,
          name,
          idempotencyKey,
          { params, body },
          run,
        );
      } else {
        result = await run();
      }

      if (def.response === null) return reply.code(204).send();
      return reply.code(def.successStatus ?? 200).send(result);
    },
  });
}

/**
 * A claim without a stored response older than this is treated as abandoned
 * (its request crashed, or failed and could not release it) and may be taken
 * over. Far longer than any idempotent handler runs.
 */
export const IDEMPOTENCY_CLAIM_LEASE = '2 minutes';
/** Claim attempts before a key that keeps being released and re-claimed is reported as CONFLICT. */
const CLAIM_ATTEMPTS = 3;

type Claim = { owned: true } | { owned: false; replay: unknown };

/**
 * Replays the stored response for a repeated Idempotency-Key, rejects reuse of
 * a key with a different request, and reports a concurrent duplicate as CONFLICT.
 *
 * Only the request whose INSERT created the claim (or that took over an
 * abandoned one) runs the handler. Each claim carries a random token, so a
 * request stores its response into, or releases, only the claim it holds.
 */
async function withIdempotency(
  deps: AppDeps,
  ctx: RequestContext,
  log: FastifyBaseLogger,
  route: string,
  key: string,
  request: unknown,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const requestHash = hashObject(request);
  const token = randomUUID();
  const claim = await withContext(deps.db, ctx, async (trx): Promise<Claim> => {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
      // Waits for a concurrent claim of the same key to commit or roll back.
      const inserted = await trx
        .insertInto('idempotency_keys')
        .values({
          user_id: ctx.userId,
          tenant_id: ctx.tenantId,
          route,
          key,
          request_hash: requestHash,
          claim_token: token,
        })
        .onConflict((oc) => oc.columns(['user_id', 'route', 'key']).doNothing())
        .returning('key')
        .executeTakeFirst();
      if (inserted) return { owned: true };

      const takenOver = await trx
        .updateTable('idempotency_keys')
        .set({ claim_token: token, created_at: sql<Date>`now()` })
        .where('user_id', '=', ctx.userId)
        .where('route', '=', route)
        .where('key', '=', key)
        .where('request_hash', '=', requestHash)
        .where('response_status', 'is', null)
        .where('created_at', '<', sql<Date>`now() - ${IDEMPOTENCY_CLAIM_LEASE}::interval`)
        .returning('key')
        .executeTakeFirst();
      if (takenOver) return { owned: true };

      const existing = await trx
        .selectFrom('idempotency_keys')
        .select(['request_hash', 'response_status', 'response_body'])
        .where('user_id', '=', ctx.userId)
        .where('route', '=', route)
        .where('key', '=', key)
        .executeTakeFirst();
      // Released between the INSERT and this read: claim it again.
      if (!existing) continue;
      if (existing.request_hash !== requestHash) {
        throw new AppError(
          'IDEMPOTENCY_MISMATCH',
          'This Idempotency-Key was used for a different request',
        );
      }
      if (existing.response_status === null)
        throw new AppError('CONFLICT', 'An identical request is still in progress');
      return { owned: false, replay: existing.response_body };
    }
    throw new AppError('CONFLICT', 'An identical request is still in progress');
  });
  if (!claim.owned) return claim.replay;

  try {
    const result = await run();
    const stored = await withContext(deps.db, ctx, (trx) =>
      trx
        .updateTable('idempotency_keys')
        .set({ response_status: 200, response_body: JSON.stringify(result ?? null) })
        .where('user_id', '=', ctx.userId)
        .where('route', '=', route)
        .where('key', '=', key)
        .where('claim_token', '=', token)
        .where('response_status', 'is', null)
        .executeTakeFirst(),
    );
    if (Number(stored.numUpdatedRows) === 0)
      log.warn({ route }, 'idempotency claim was taken over before its response was stored');
    return result;
  } catch (err) {
    // Release this request's own claim, still unanswered, so the client can retry.
    // A claim left behind (e.g. the database is down) is taken over after the lease.
    await withContext(deps.db, ctx, (trx) =>
      trx
        .deleteFrom('idempotency_keys')
        .where('user_id', '=', ctx.userId)
        .where('route', '=', route)
        .where('key', '=', key)
        .where('claim_token', '=', token)
        .where('response_status', 'is', null)
        .execute(),
    ).catch((releaseErr: unknown) =>
      log.warn({ err: releaseErr, route }, 'idempotency claim release failed'),
    );
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
