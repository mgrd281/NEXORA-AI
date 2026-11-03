/**
 * GET /v1/events — Server-Sent Events stream of the signed-in user's events.
 *
 *   - Resumable: events newer than `Last-Event-ID` (header, or `?lastEventId=`
 *     for clients that cannot set headers) are replayed from task_events.
 *   - Live: pg_notify on `jarvis_events` carries {u, id} for persisted events
 *     and {u, e} for ephemeral ones (answer deltas). Notices for other users
 *     are dropped, and persisted rows are re-read through RLS, so the database
 *     double-checks ownership before anything is written to the socket.
 *   - Persisted events carry `id:` (the task_events id); ephemeral ones do not,
 *     so they never move the client's resume position.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { EVENTS_PATH, StreamEvent } from '@jarvis/contracts';
import { withContext, type DbContext } from '../../db/pool';
import { AppError } from '../../lib/errors';
import type { AppDeps } from '../../services';
import { EVENTS_CHANNEL } from '../events/events';

export const SSE_RETRY_MS = 3000;
export const HEARTBEAT_MS = 25_000;
export const REPLAY_LIMIT = 200;
/** A client that stops reading is disconnected before its buffer grows past this. */
const MAX_BUFFERED_BYTES = 1_000_000;
/** Concurrent streams per user (tabs and devices); more are refused with RATE_LIMITED. */
export const MAX_STREAMS_PER_USER = 10;

interface Notice {
  u: string;
  id?: unknown;
  e?: unknown;
}

interface EventRow {
  id: number;
  task_id: string | null;
  type: string;
  data: Record<string, unknown>;
  created_at: Date;
}

function parseNotice(payload: string): Notice | null {
  try {
    const v = JSON.parse(payload) as unknown;
    if (!v || typeof v !== 'object' || typeof (v as Notice).u !== 'string') return null;
    return v as Notice;
  } catch {
    return null;
  }
}

/** Last-Event-ID header, else ?lastEventId=; only positive integer ids are meaningful. */
export function parseLastEventId(req: Pick<FastifyRequest, 'headers' | 'query'>): number | null {
  const header = req.headers['last-event-id'];
  const query = (req.query as Record<string, unknown> | undefined)?.lastEventId;
  const raw = typeof header === 'string' && header !== '' ? header : query;
  if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

function toStreamEvent(r: EventRow): StreamEvent | null {
  const parsed = StreamEvent.safeParse({
    id: String(r.id),
    type: r.type,
    taskId: r.task_id,
    at: r.created_at.toISOString(),
    data: r.data ?? {},
  });
  return parsed.success ? parsed.data : null;
}

const EVENT_COLUMNS = ['id', 'task_id', 'type', 'data', 'created_at'] as const;

export function registerStreamRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  /** Open streams, ended on shutdown so app.close() does not wait for clients. */
  const open = new Set<() => void>();
  const perUser = new Map<string, number>();
  app.addHook('preClose', async () => {
    for (const end of [...open]) end();
  });

  app.get(EVENTS_PATH, async (req, reply) => {
    const ctx = req.ctx;
    if (!ctx) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    const dbCtx: DbContext = { tenantId: ctx.tenantId, userId: ctx.userId };
    const lastEventId = parseLastEventId(req);
    const streams = perUser.get(ctx.userId) ?? 0;
    if (streams >= MAX_STREAMS_PER_USER)
      throw new AppError(
        'RATE_LIMITED',
        'Too many open event streams. Close another tab or device.',
      );
    perUser.set(ctx.userId, streams + 1);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);

    let closed = false;
    let unlisten: (() => Promise<void>) | null = null;
    const heartbeat = setInterval(() => write(': heartbeat\n\n'), HEARTBEAT_MS);

    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      open.delete(end);
      const left = (perUser.get(dbCtx.userId) ?? 1) - 1;
      if (left > 0) perUser.set(dbCtx.userId, left);
      else perUser.delete(dbCtx.userId);
      const u = unlisten;
      unlisten = null;
      if (u) void u().catch((err: unknown) => req.log.warn({ err }, 'sse unsubscribe failed'));
    }
    function end() {
      cleanup();
      res.end();
    }
    function write(chunk: string) {
      if (closed) return;
      res.write(chunk);
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        req.log.warn('sse client too slow; disconnecting');
        cleanup();
        res.destroy();
      }
    }
    const sendPersisted = (ev: StreamEvent) =>
      write(`id: ${ev.id}\nevent: message\ndata: ${JSON.stringify(ev)}\n\n`);
    const sendEphemeral = (ev: StreamEvent) =>
      write(`event: message\ndata: ${JSON.stringify(ev)}\n\n`);

    open.add(end);
    res.on('close', cleanup);
    res.on('error', cleanup);

    // Ids already written by the replay; a notice for one of them is a duplicate.
    const replayed = new Set<number>();
    let live = false;
    const backlog: Notice[] = [];
    let chain: Promise<void> = Promise.resolve();

    async function deliver(n: Notice) {
      if (closed) return;
      if (typeof n.id === 'number' && Number.isSafeInteger(n.id)) {
        if (replayed.has(n.id)) return;
        const id = n.id;
        const row = await withContext(db, dbCtx, (trx) =>
          trx
            .selectFrom('task_events')
            .select(EVENT_COLUMNS)
            .where('id', '=', id)
            .where('user_id', '=', dbCtx.userId)
            .executeTakeFirst(),
        );
        const ev = row ? toStreamEvent(row) : null;
        if (ev) sendPersisted(ev);
      } else if (n.e !== undefined) {
        const ev = StreamEvent.safeParse(n.e);
        if (ev.success) sendEphemeral(ev.data);
      }
    }
    // Deliveries run strictly in arrival order.
    const enqueue = (n: Notice) => {
      chain = chain
        .then(() => deliver(n))
        .catch((err: unknown) => req.log.warn({ err }, 'sse delivery failed'));
    };

    try {
      // Subscribe before replaying so nothing committed in between is missed.
      const stop = await deps.listen(EVENTS_CHANNEL, (payload) => {
        const n = parseNotice(payload);
        if (!n || n.u !== dbCtx.userId) return;
        if (live) enqueue(n);
        else backlog.push(n);
      });
      if (closed) {
        await stop();
        return;
      }
      unlisten = stop;

      if (lastEventId !== null) {
        // The newest REPLAY_LIMIT events after the client's position, oldest first.
        const rows = await withContext(db, dbCtx, (trx) =>
          trx
            .selectFrom('task_events')
            .select(EVENT_COLUMNS)
            .where('user_id', '=', dbCtx.userId)
            .where('id', '>', lastEventId)
            .orderBy('id', 'desc')
            .limit(REPLAY_LIMIT)
            .execute(),
        );
        for (const row of rows.reverse()) {
          replayed.add(row.id);
          const ev = toStreamEvent(row);
          if (ev) sendPersisted(ev);
        }
      }
      live = true;
      for (const n of backlog.splice(0)) enqueue(n);
    } catch (err) {
      req.log.error({ err }, 'event stream setup failed');
      // The client reconnects after `retry`.
      end();
    }
  });
}
