/**
 * Phase D — the telephony HTTP surfaces (owner: telephony engineer;
 * docs/architecture/phase-d.md §2, §3.3, §3.7, §6):
 *   user routes (defineRoute, session-authenticated, RLS): listCalls (keyset (created_at DESC,
 *     id DESC), result filter), getCall (every turn), listDoNotCall, deleteDoNotCall (audited),
 *     getPhoneVerification (the live one, to resume), startPhoneVerification (5/min per user),
 *     confirmPhoneVerification;
 *   provider webhooks (registerTelephonyWebhooks: signature-validated, no session):
 *     twilioCallVoice, twilioCallGather, twilioCallStatus, twilioCallAmd, twilioCallDial,
 *     twilioCallRecording (webhooks.ts), twilioVerificationVoice, twilioVerificationStatus
 *     (verification.ts).
 * No HTTP route places a call: calls are made only by the agent, with approval.
 */
import type { FastifyInstance } from 'fastify';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { registerTelephonyWebhooks } from '../../http/webhook-route';
import { notFound } from '../../lib/errors';
import type { AppDeps } from '../../services';
import { audit } from '../audit/audit';
import { afterCursor, cursorTimestamp, decodeCursor, toPage } from '../home/cursor';
import {
  CALL_COLUMNS,
  doNotCallQuery,
  recordingsOf,
  toCallListItem,
  toCallSession,
  toDoNotCallEntry,
  turnsOf,
} from './mappers';
import {
  confirmPhoneVerification,
  currentPhoneVerification,
  registerVerificationWebhooks,
  startPhoneVerification,
} from './verification';
import { registerCallWebhooks } from './webhooks';

export async function registerTelephonyRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  defineRoute(app, deps, 'listCalls', async ({ ctx, query }) => {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    return withContext(db, ctx, async (trx) => {
      let b = trx
        .selectFrom('call_sessions as c')
        .innerJoin('tasks as t', 't.id', 'c.task_id')
        .select(CALL_COLUMNS.map((col) => `c.${col}` as const))
        .select(['t.title as task_title', 't.title_message as task_title_message'])
        .select(cursorTimestamp('c.created_at').as('cursor_ts'))
        .where('c.user_id', '=', ctx.userId);
      if (query.result) b = b.where('c.result', '=', query.result);
      if (cursor) b = b.where(afterCursor('c.created_at', 'c.id', cursor));
      const rows = await b
        .orderBy('c.created_at', 'desc')
        .orderBy('c.id', 'desc')
        .limit(query.limit + 1)
        .execute();
      const recordings = await recordingsOf(
        trx,
        rows.slice(0, query.limit).map((r) => r.id),
      );
      return toPage(rows, query.limit, (r) => toCallListItem(r, recordings.get(r.id) ?? null));
    });
  });

  defineRoute(app, deps, 'getCall', async ({ ctx, params }) => {
    const call = await withContext(db, ctx, async (trx) => {
      const row = await trx
        .selectFrom('call_sessions')
        .select(CALL_COLUMNS)
        .where('id', '=', params.id)
        .executeTakeFirst();
      if (!row) return null;
      const [turns, recordings] = await Promise.all([
        turnsOf(trx, [row.id]),
        recordingsOf(trx, [row.id]),
      ]);
      return toCallSession(row, turns.get(row.id) ?? [], recordings.get(row.id) ?? null);
    });
    if (!call) throw notFound('Call');
    return call;
  });

  defineRoute(app, deps, 'listDoNotCall', async ({ ctx }) =>
    withContext(db, ctx, async (trx) => {
      const rows = await doNotCallQuery(trx)
        .orderBy('d.created_at', 'desc')
        .orderBy('d.id', 'desc')
        .execute();
      return { items: rows.map(toDoNotCallEntry) };
    }),
  );

  defineRoute(app, deps, 'deleteDoNotCall', async ({ ctx, params }) => {
    const removed = await withContext(db, ctx, async (trx) => {
      const row = await trx
        .deleteFrom('do_not_call')
        .where('id', '=', params.id)
        .returning(['id', 'source'])
        .executeTakeFirst();
      if (!row) return false;
      // The user may correct a misunderstanding; who asked stays in the audit trail.
      await audit(trx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'do_not_call.removed',
        targetType: 'do_not_call',
        targetId: row.id,
        metadata: { source: row.source },
      });
      return true;
    });
    if (!removed) throw notFound('Do-not-call entry');
  });

  defineRoute(app, deps, 'getPhoneVerification', async ({ ctx }) =>
    currentPhoneVerification(deps, ctx),
  );

  defineRoute(
    app,
    deps,
    'startPhoneVerification',
    async ({ ctx }) => startPhoneVerification(deps, ctx),
    {
      rateLimit: { max: 5, timeWindow: '1 minute' },
    },
  );

  defineRoute(app, deps, 'confirmPhoneVerification', async ({ ctx, body }) =>
    confirmPhoneVerification(deps, ctx, body.code),
  );

  await registerTelephonyWebhooks(app, deps, (define) => {
    registerCallWebhooks(deps, define);
    registerVerificationWebhooks(deps, define);
  });
}
