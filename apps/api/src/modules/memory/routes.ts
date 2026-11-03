import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { Memory } from '@jarvis/contracts';
import { withContext } from '../../db/pool';
import type { MemoryRow } from '../../db/types';
import { defineRoute } from '../../http/route';
import { notFound } from '../../lib/errors';
import type { AppDeps } from '../../services';
import { audit } from '../audit/audit';
import { afterCursor, cursorTimestamp, decodeCursor, toPage } from '../home/cursor';

export const MEMORY_COLUMNS = [
  'id',
  'kind',
  'content',
  'source',
  'source_task_id',
  'created_at',
  'updated_at',
] as const;

export function toMemory(r: Pick<MemoryRow, (typeof MEMORY_COLUMNS)[number]>): Memory {
  return {
    id: r.id,
    kind: r.kind,
    content: r.content,
    source: r.source,
    sourceTaskId: r.source_task_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Escapes LIKE/ILIKE wildcards so user input matches literally (backslash is the default escape). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function registerMemoryRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'listMemories', async ({ ctx, query }) => {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const q = query.q?.trim() || null;
    const rows = await withContext(db, ctx, (trx) => {
      let b = trx
        .selectFrom('memories as m')
        .select(MEMORY_COLUMNS.map((c) => `m.${c}` as const))
        .select(cursorTimestamp('m.created_at').as('cursor_ts'))
        .where('m.user_id', '=', ctx.userId);
      if (q) {
        // Word match via the 'simple' full-text index, or a literal substring match.
        b = b.where((eb) =>
          eb.or([
            sql<boolean>`m.search @@ plainto_tsquery('simple', ${q})`,
            eb('m.content', 'ilike', `%${escapeLike(q)}%`),
          ]),
        );
      }
      if (cursor) b = b.where(afterCursor('m.created_at', 'm.id', cursor));
      return b
        .orderBy('m.created_at', 'desc')
        .orderBy('m.id', 'desc')
        .limit(query.limit + 1)
        .execute();
    });
    return toPage(rows, query.limit, toMemory);
  });

  defineRoute(app, deps, 'createMemory', async ({ ctx, body }) => {
    const row = await withContext(db, ctx, (trx) =>
      trx
        .insertInto('memories')
        .values({
          tenant_id: ctx.tenantId,
          user_id: ctx.userId,
          kind: body.kind,
          content: body.content,
          source: 'user',
        })
        .returning(MEMORY_COLUMNS)
        .executeTakeFirstOrThrow(),
    );
    return toMemory(row);
  });

  defineRoute(app, deps, 'updateMemory', async ({ ctx, params, body }) => {
    const row = await withContext(db, ctx, (trx) => {
      const changes = {
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.content !== undefined ? { content: body.content } : {}),
      };
      if (Object.keys(changes).length === 0) {
        return trx
          .selectFrom('memories')
          .select(MEMORY_COLUMNS)
          .where('id', '=', params.id)
          .executeTakeFirst();
      }
      return trx
        .updateTable('memories')
        .set(changes)
        .where('id', '=', params.id)
        .returning(MEMORY_COLUMNS)
        .executeTakeFirst();
    });
    if (!row) throw notFound('Memory');
    return toMemory(row);
  });

  defineRoute(app, deps, 'deleteMemory', async ({ ctx, params }) => {
    await withContext(db, ctx, async (trx) => {
      const res = await trx.deleteFrom('memories').where('id', '=', params.id).executeTakeFirst();
      if (Number(res.numDeletedRows) === 0) throw notFound('Memory');
      await audit(trx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'memory.deleted',
        targetType: 'memory',
        targetId: params.id,
      });
    });
  });

  defineRoute(app, deps, 'deleteAllMemories', async ({ ctx }) => {
    const deleted = await withContext(db, ctx, async (trx) => {
      const res = await trx
        .deleteFrom('memories')
        .where('user_id', '=', ctx.userId)
        .executeTakeFirst();
      const count = Number(res.numDeletedRows);
      await audit(trx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'memory.deleted_all',
        targetType: 'user',
        targetId: ctx.userId,
        metadata: { count },
      });
      return count;
    });
    return { deleted };
  });
}
