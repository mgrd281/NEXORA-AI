/** Outbound webhooks HTTP surface (docs/architecture/phase-b.md §3.8). */
import type { FastifyInstance } from 'fastify';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { notFound } from '../../lib/errors';
import type { AppDeps } from '../../services';
import { afterCursor, cursorTimestamp, decodeCursor, toPage } from '../home/cursor';
import { DELIVERY_COLUMNS, toWebhookDelivery } from './mappers';
import {
  checkEndpointUrl,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookEndpoints,
  rotateWebhookSecret,
  sendTestWebhook,
  updateWebhookEndpoint,
  type WebhookDeps,
} from './service';
import type { ResolveHost } from './url';

export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  opts: { resolve?: ResolveHost } = {},
) {
  const { db } = deps;
  const wd: WebhookDeps = { config: deps.config, secrets: deps.secrets, resolve: opts.resolve };

  defineRoute(app, deps, 'listWebhooks', async ({ ctx }) => ({
    items: await withContext(db, ctx, (trx) => listWebhookEndpoints(trx, ctx.userId)),
  }));

  defineRoute(
    app,
    deps,
    'createWebhook',
    async ({ ctx, body }) => {
      const url = await checkEndpointUrl(wd, body.url);
      return withContext(db, ctx, (trx) => createWebhookEndpoint(trx, ctx, wd, body, url));
    },
    { rateLimit: { max: 20, timeWindow: '1 minute' } },
  );

  defineRoute(app, deps, 'updateWebhook', async ({ ctx, params, body }) => {
    const url = body.url === undefined ? undefined : await checkEndpointUrl(wd, body.url);
    return withContext(db, ctx, (trx) => updateWebhookEndpoint(trx, ctx, wd, params.id, body, url));
  });

  defineRoute(app, deps, 'deleteWebhook', async ({ ctx, params }) => {
    await withContext(db, ctx, (trx) => deleteWebhookEndpoint(trx, ctx, params.id));
  });

  defineRoute(
    app,
    deps,
    'rotateWebhookSecret',
    async ({ ctx, params }) =>
      withContext(db, ctx, (trx) => rotateWebhookSecret(trx, ctx, wd, params.id)),
    { rateLimit: { max: 10, timeWindow: '1 minute' } },
  );

  defineRoute(
    app,
    deps,
    'testWebhook',
    async ({ ctx, params }) => withContext(db, ctx, (trx) => sendTestWebhook(trx, ctx, params.id)),
    { rateLimit: { max: 5, timeWindow: '1 minute' } },
  );

  defineRoute(app, deps, 'listWebhookDeliveries', async ({ ctx, params, query }) => {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await withContext(db, ctx, async (trx) => {
      const endpoint = await trx
        .selectFrom('webhook_endpoints')
        .select('id')
        .where('id', '=', params.id)
        .executeTakeFirst();
      if (!endpoint) throw notFound('Webhook endpoint');
      let q = trx
        .selectFrom('webhook_deliveries as d')
        .select(DELIVERY_COLUMNS.map((c) => `d.${c}` as const))
        .select(cursorTimestamp('d.created_at').as('cursor_ts'))
        .where('d.endpoint_id', '=', params.id);
      if (cursor) q = q.where(afterCursor('d.created_at', 'd.id', cursor));
      return q
        .orderBy('d.created_at', 'desc')
        .orderBy('d.id', 'desc')
        .limit(query.limit + 1)
        .execute();
    });
    return toPage(rows, query.limit, toWebhookDelivery);
  });
}
