import type { FastifyInstance } from 'fastify';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { AppError, notFound } from '../../lib/errors';
import type { AppDeps } from '../../services';
import { loadMe } from '../account/me';
import { monthlyAiSpend } from '../agent/context';
import { usdToMicro } from '../agent/models/pricing';
import { effectiveTimeZone } from '../../lib/period';
import { speechConfigured, speechCostMicro, synthesizeSpeech } from './speech';

/**
 * Voice sessions record metadata only (engine, locale, outcome, transcript
 * length; Phase D: the mode, the conversation and counters of a conversation).
 * Audio never leaves the device and transcript text is never stored here — the
 * recognised requests arrive separately as tasks.
 */
const COLUMNS = ['id', 'started_at', 'ended_at', 'mode', 'conversation_id'] as const;
const toVoiceSession = (r: {
  id: string;
  started_at: Date;
  ended_at: Date | null;
  mode: 'dictation' | 'conversation';
  conversation_id: string | null;
}) => ({
  id: r.id,
  startedAt: r.started_at.toISOString(),
  endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
  mode: r.mode,
  conversationId: r.conversation_id,
});

export function registerVoiceRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'startVoiceSession', async ({ ctx, body }) => {
    const row = await withContext(db, ctx, async (trx) => {
      // Phase D: only the caller's own conversation (foreign keys do not see RLS).
      if (body.conversationId) {
        const own = await trx
          .selectFrom('conversations')
          .select('id')
          .where('id', '=', body.conversationId)
          .executeTakeFirst();
        if (!own) throw notFound('Conversation');
      }
      return trx
        .insertInto('voice_sessions')
        .values({
          tenant_id: ctx.tenantId,
          user_id: ctx.userId,
          locale: body.locale,
          engine: body.engine,
          mode: body.mode,
          conversation_id: body.conversationId ?? null,
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
    });
    return toVoiceSession(row);
  });

  // Natural voice: one sentence group per request (the apps split replies into chunks).
  defineRoute(
    app,
    deps,
    'synthesizeSpeech',
    async ({ ctx, body, reply }) => {
      if (!speechConfigured(deps.config))
        throw new AppError(
          'SERVICE_UNAVAILABLE',
          'The natural voice is not set up on this server.',
        );
      await withContext(db, ctx, async (trx) => {
        const me = await loadMe(trx, ctx.userId);
        if (!me.preferences.ai.allowExternalModels)
          throw new AppError(
            'SERVICE_UNAVAILABLE',
            'External models are turned off in your settings, so the device voice is used.',
          );
        const spent = await monthlyAiSpend(trx, await effectiveTimeZone(trx, me.timeZone));
        if (spent >= usdToMicro(me.preferences.spending.monthlyAiBudgetUsd))
          throw new AppError('BUDGET_EXCEEDED', 'The monthly AI budget is used up.');
      });
      const speech = await synthesizeSpeech(deps.config, body);
      // Metered as model spend (it counts toward the monthly AI budget).
      await withContext(db, ctx, (trx) =>
        trx
          .insertInto('cost_records')
          .values({
            tenant_id: ctx.tenantId,
            user_id: ctx.userId,
            task_id: null,
            category: 'model',
            amount_micro: speechCostMicro(body.text.length),
          })
          .execute(),
      );
      reply
        .code(200)
        .header('content-type', speech.mediaType)
        .header('content-length', String(speech.audio.length))
        .header('cache-control', 'no-store')
        .header('x-voice-model', speech.model)
        .send(speech.audio);
    },
    // Replies are chunked per sentence group: allow a steady conversation, bound abuse.
    { rateLimit: { max: 120, timeWindow: '1 minute' } },
  );

  defineRoute(app, deps, 'endVoiceSession', async ({ ctx, params, body }) => {
    const row = await withContext(db, ctx, async (trx) => {
      const ended = await trx
        .updateTable('voice_sessions')
        .set({
          ended_at: new Date(),
          outcome: body.outcome,
          transcript_chars: body.transcriptChars,
          error_code: body.errorCode ?? null,
          // Phase D: conversation counters (absent for dictation).
          turn_count: body.turns ?? null,
          barge_in_count: body.bargeIns ?? null,
          reconnect_count: body.reconnects ?? null,
          end_reason: body.endReason ?? null,
        })
        .where('id', '=', params.id)
        .where('ended_at', 'is', null)
        .returning(COLUMNS)
        .executeTakeFirst();
      if (ended) return ended;
      // Already ended (e.g. a retried request): report the recorded end unchanged.
      return trx
        .selectFrom('voice_sessions')
        .select(COLUMNS)
        .where('id', '=', params.id)
        .executeTakeFirst();
    });
    if (!row) throw notFound('Voice session');
    return toVoiceSession(row);
  });
}
