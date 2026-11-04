/**
 * Phase D — the telephony webhook route group (docs/architecture/phase-d.md §3.3,
 * docs/adr/0020-telephony-gateway.md). Contract: @jarvis/contracts telephonyWebhookRoutes.
 *
 * These routes are outside the user API table and its session authentication: Twilio
 * sends no session and no CSRF Origin. Each request is authenticated here, before any
 * handler runs, in this order:
 *   1. telephony configured on this server (else 404: the routes do not exist);
 *   2. an application/x-www-form-urlencoded body of at most
 *      TELEPHONY_WEBHOOK_LIMITS.maxBodyBytes (a parser registered in this scope only);
 *   3. X-Twilio-Signature valid for PUBLIC_WEBHOOK_BASE_URL + the path and query as
 *      received and every form parameter (lib/twilio-signature.ts, constant time) —
 *      else 403 WEBHOOK_SIGNATURE_INVALID, nothing read, nothing written;
 *   4. AccountSid = this server's TWILIO_ACCOUNT_SID (else 403);
 *   5. params / query / form valid for the route's contract schemas (else 400);
 *   6. the call's (or verification's) owner found by its id AND the hash of its URL
 *      token (`t`) through the SECURITY DEFINER function telephony_webhook_target —
 *      else 404. The handler then runs in that owner's RLS context only.
 * Replay, ordering and idempotency (status SequenceNumber, Timestamp age, gather turn
 * `n`, ended calls) are the handlers' rules (§3.3), on top of these checks. Responses:
 * TwiML (text/xml) or 204; errors use the API error shape (Twilio only logs them).
 *
 * The global hooks still run (request id, the auth hook — which finds no session —, the
 * NUL check); the global rate limit is raised for these routes (Twilio sends bursts
 * from shared addresses), keyed by IP as every unauthenticated request is.
 */
import {
  telephonyWebhookRoutes,
  TELEPHONY_WEBHOOK_LIMITS,
  TWILIO_SIGNATURE_HEADER,
  type TelephonyWebhookDef,
  type TelephonyWebhookName,
} from '@jarvis/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { z } from 'zod';
import type { DbContext } from '../db/pool';
import { sha256 } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { formParams, verifyTwilioSignature } from '../lib/twilio-signature';
import type { AppDeps } from '../services';

type Def<N extends TelephonyWebhookName> = (typeof telephonyWebhookRoutes)[N];

export interface TelephonyWebhookInput<N extends TelephonyWebhookName> {
  params: z.output<Def<N>['params']>;
  query: z.output<Def<N>['query']>;
  /** The provider's parameters (validated; unknown ones kept: they are signed too). */
  form: z.output<Def<N>['form']>;
  /** The owner of the call / verification: run every query in this context only. */
  ctx: DbContext;
  /** The public URL the signature was checked against. */
  url: string;
  /** When the request arrived (replay windows). */
  receivedAt: Date;
  req: FastifyRequest;
}

/** TwiML to return (text/xml), or nothing (204). */
export type TelephonyWebhookReply = { twiml: string } | { empty: true };

export type TelephonyWebhookHandler<N extends TelephonyWebhookName> = (
  input: TelephonyWebhookInput<N>,
) => Promise<TelephonyWebhookReply>;

export type DefineTelephonyWebhook = <N extends TelephonyWebhookName>(
  name: N,
  handler: TelephonyWebhookHandler<N>,
) => void;

/** Requests per minute and address for these routes (instead of the global 300). */
export const TELEPHONY_WEBHOOK_RATE_LIMIT = { max: 1_200, timeWindow: '1 minute' } as const;

const FORM = 'application/x-www-form-urlencoded';
const registered = new WeakMap<FastifyInstance, Set<TelephonyWebhookName>>();

const forbidden = () =>
  new AppError('FORBIDDEN', 'Invalid webhook signature', { reason: 'WEBHOOK_SIGNATURE_INVALID' });

function parse<S extends z.ZodType>(schema: S, value: unknown, where: string): z.output<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success)
    throw new AppError('VALIDATION_FAILED', `Invalid ${where}`, {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  return r.data;
}

/**
 * Registers the telephony webhooks `register` defines, in their own encapsulated scope
 * (the form-body parser exists there only). `app` is the root instance: the boot check
 * (assertAllWebhooksRegistered) counts the routes against it.
 */
export async function registerTelephonyWebhooks(
  app: FastifyInstance,
  deps: AppDeps,
  register: (define: DefineTelephonyWebhook) => void,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      FORM,
      { parseAs: 'string', bodyLimit: TELEPHONY_WEBHOOK_LIMITS.maxBodyBytes },
      (_req, body, done) => done(null, new URLSearchParams(body as string)),
    );

    const define: DefineTelephonyWebhook = (name, handler) => {
      const def = telephonyWebhookRoutes[name] as TelephonyWebhookDef;
      const set = registered.get(app) ?? new Set();
      if (set.has(name)) throw new Error(`telephony webhook ${name} is registered twice`);
      set.add(name);
      registered.set(app, set);

      scope.route({
        method: def.method,
        url: def.path,
        config: { routeName: name, rateLimit: TELEPHONY_WEBHOOK_RATE_LIMIT },
        handler: async (req, reply) => {
          const receivedAt = new Date();
          const telephony = deps.config.telephony;
          if (!telephony) throw new AppError('NOT_FOUND', 'Route not found');
          if (!(req.body instanceof URLSearchParams))
            throw new AppError('UNSUPPORTED_MEDIA_TYPE', `Expected ${FORM}`);
          const url = `${telephony.webhookBase}${req.url}`;
          const signed = formParams(req.body);
          if (
            !verifyTwilioSignature(
              telephony.authToken,
              url,
              signed,
              req.headers[TWILIO_SIGNATURE_HEADER],
            )
          ) {
            req.log.warn({ route: name }, 'telephony webhook with an invalid signature');
            throw forbidden();
          }
          if (signed.AccountSid !== telephony.accountSid) throw forbidden();

          const params = parse(def.params, req.params, 'path parameters');
          const query = parse(def.query, req.query, 'query') as { t: string };
          const form = parse(def.form, Object.fromEntries(req.body), 'form');
          const id = (params as Record<string, string>)[
            def.target === 'call' ? 'callId' : 'verificationId'
          ]!;
          const owner = await sql<{ tenant_id: string; user_id: string }>`
            select tenant_id, user_id
              from telephony_webhook_target(${def.target}, ${id}::uuid, ${sha256(query.t)})`.execute(
            deps.db,
          );
          const row = owner.rows[0];
          if (!row) throw new AppError('NOT_FOUND', 'Route not found');

          const out = await handler({
            params,
            query,
            form,
            ctx: { tenantId: row.tenant_id, userId: row.user_id },
            url,
            receivedAt,
            req,
          } as unknown as TelephonyWebhookInput<typeof name>);
          if ('twiml' in out)
            return reply
              .code(200)
              .header('content-type', 'text/xml; charset=utf-8')
              .header('cache-control', 'no-store')
              .send(out.twiml);
          return reply.code(204).send();
        },
      });
    };
    register(define);
  });
}

/** Throws at boot if any telephony webhook of the contract has no handler. */
export function assertAllWebhooksRegistered(
  app: FastifyInstance,
  opts: {
    /**
     * Phase D stage 1 → 2 (docs/architecture/phase-d.md §0): webhooks whose handlers have
     * not landed yet. Tolerated only outside production (they answer 404 — never a
     * placeholder); a production boot with any of them fails. A pending webhook that has
     * a handler is an error too, so the list only ever shrinks to empty.
     */
    pending?: ReadonlySet<TelephonyWebhookName>;
    production?: boolean;
  } = {},
): void {
  const set = registered.get(app) ?? new Set();
  const pending = opts.production
    ? new Set<TelephonyWebhookName>()
    : (opts.pending ?? new Set<TelephonyWebhookName>());
  const stale = [...(opts.pending ?? [])].filter((n) => set.has(n));
  if (stale.length)
    throw new Error(
      `Telephony webhooks listed as pending but registered (remove them from the list): ${stale.join(', ')}`,
    );
  const missing = (Object.keys(telephonyWebhookRoutes) as TelephonyWebhookName[]).filter(
    (n) => !set.has(n) && !pending.has(n),
  );
  if (missing.length) throw new Error(`Telephony webhooks without handlers: ${missing.join(', ')}`);
}
