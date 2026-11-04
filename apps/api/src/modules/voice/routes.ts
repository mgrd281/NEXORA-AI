import type { FastifyInstance } from 'fastify';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { notFound } from '../../lib/errors';
import type { AppDeps } from '../../services';

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
