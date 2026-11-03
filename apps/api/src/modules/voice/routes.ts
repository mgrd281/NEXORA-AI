import type { FastifyInstance } from 'fastify';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { notFound } from '../../lib/errors';
import type { AppDeps } from '../../services';

/**
 * Voice sessions record metadata only (engine, locale, outcome, transcript
 * length). Audio never leaves the device and transcript text is never stored
 * here — the recognised request arrives separately as a task.
 */
const toVoiceSession = (r: { id: string; started_at: Date; ended_at: Date | null }) => ({
  id: r.id,
  startedAt: r.started_at.toISOString(),
  endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
});

export function registerVoiceRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'startVoiceSession', async ({ ctx, body }) => {
    const row = await withContext(db, ctx, (trx) =>
      trx
        .insertInto('voice_sessions')
        .values({
          tenant_id: ctx.tenantId,
          user_id: ctx.userId,
          locale: body.locale,
          engine: body.engine,
        })
        .returning(['id', 'started_at', 'ended_at'])
        .executeTakeFirstOrThrow(),
    );
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
        })
        .where('id', '=', params.id)
        .where('ended_at', 'is', null)
        .returning(['id', 'started_at', 'ended_at'])
        .executeTakeFirst();
      if (ended) return ended;
      // Already ended (e.g. a retried request): report the recorded end unchanged.
      return trx
        .selectFrom('voice_sessions')
        .select(['id', 'started_at', 'ended_at'])
        .where('id', '=', params.id)
        .executeTakeFirst();
    });
    if (!row) throw notFound('Voice session');
    return toVoiceSession(row);
  });
}
