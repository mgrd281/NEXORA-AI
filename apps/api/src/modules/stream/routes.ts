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
 *   - Bound to the session that opened it. The database announces a revoked,
 *     deleted or expired-early session and a disabled or deleted user on
 *     `jarvis_sessions` (migration 0003); every API instance ends the matching
 *     streams at once. The stream also ends at the session's expiry time, and
 *     each heartbeat re-validates the session in case a notice was missed
 *     (e.g. while the LISTEN connection was reconnecting). The client's
 *     reconnect is then refused with 401.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { EVENTS_PATH, StreamEvent } from '@jarvis/contracts';
import { withContext, type DbContext } from '../../db/pool';
import { sessionToken } from '../../http/app';
import { AppError } from '../../lib/errors';
import { metrics } from '../../observability';
import type { AppDeps } from '../../services';
import { resolveSession } from '../auth/sessions';
import { EVENTS_CHANNEL } from '../events/events';

export const SSE_RETRY_MS = 3000;
/** Keep-alive comment and session re-validation interval. */
export const HEARTBEAT_MS = 25_000;
export const REPLAY_LIMIT = 200;
/** A client that stops reading is disconnected before its buffer grows past this. */
const MAX_BUFFERED_BYTES = 1_000_000;
/** Concurrent streams per user (tabs and devices); more are refused with RATE_LIMITED. */
export const MAX_STREAMS_PER_USER = 10;
/**
 * Postgres channel on which session ends are announced (db/migrations/0003):
 * {s, u} ends the streams of session s, {u} every stream of user u.
 */
export const SESSIONS_CHANNEL = 'jarvis_sessions';
/** setTimeout's ceiling (about 24.8 days); a later expiry is reached in steps. */
const MAX_TIMER_MS = 2_147_483_647;

export interface StreamOptions {
  /** Interval of the keep-alive comment and the session re-validation (default HEARTBEAT_MS). */
  heartbeatMs?: number;
}

/** An open stream, indexed by its session and its user. */
interface OpenStream {
  sessionId: string;
  userId: string;
  end: () => void;
}

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

interface SessionNotice {
  /** The session that ended; absent when every session of the user ended. */
  s?: string;
  u: string;
}

function parseSessionNotice(payload: string): SessionNotice | null {
  const n = parseNotice(payload) as (Notice & { s?: unknown }) | null;
  if (!n || (n.s !== undefined && typeof n.s !== 'string')) return null;
  return n as SessionNotice;
}

function addTo(index: Map<string, Set<OpenStream>>, key: string, stream: OpenStream) {
  const set = index.get(key) ?? new Set<OpenStream>();
  set.add(stream);
  index.set(key, set);
}

function removeFrom(index: Map<string, Set<OpenStream>>, key: string, stream: OpenStream) {
  const set = index.get(key);
  if (!set) return;
  set.delete(stream);
  if (set.size === 0) index.delete(key);
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

export function registerStreamRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  options: StreamOptions = {},
) {
  const { db } = deps;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  // Open streams by session and by user: for session-end notices, the
  // per-user cap, and ending every stream on shutdown so app.close() does not
  // wait for clients.
  const bySession = new Map<string, Set<OpenStream>>();
  const byUser = new Map<string, Set<OpenStream>>();

  function onSessionNotice(payload: string) {
    const n = parseSessionNotice(payload);
    if (!n) return;
    const ended = n.s !== undefined ? bySession.get(n.s) : byUser.get(n.u);
    for (const stream of [...(ended ?? [])]) stream.end();
  }
  // One subscription per process, made by the first stream and kept until shutdown.
  let sessionsWatch: Promise<() => Promise<void>> | null = null;
  function watchSessions() {
    sessionsWatch ??= deps.listen(SESSIONS_CHANNEL, onSessionNotice).catch((err: unknown) => {
      sessionsWatch = null;
      throw err;
    });
    return sessionsWatch;
  }

  app.addHook('preClose', async () => {
    for (const streams of [...byUser.values()]) for (const stream of [...streams]) stream.end();
    const watch = sessionsWatch;
    sessionsWatch = null;
    const stop = await watch?.catch(() => null);
    await stop?.();
  });

  app.get(EVENTS_PATH, async (req, reply) => {
    const ctx = req.ctx;
    const presented = sessionToken(req);
    if (!ctx || !presented) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    // Kept to re-validate the session exactly as authentication did.
    const { token } = presented;
    const dbCtx: DbContext = { tenantId: ctx.tenantId, userId: ctx.userId };
    const lastEventId = parseLastEventId(req);
    if ((byUser.get(ctx.userId)?.size ?? 0) >= MAX_STREAMS_PER_USER)
      throw new AppError(
        'RATE_LIMITED',
        'Too many open event streams. Close another tab or device.',
      );

    reply.hijack();
    const res = reply.raw;
    let closed = false;
    let unlisten: (() => Promise<void>) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const stream: OpenStream = { sessionId: ctx.sessionId, userId: ctx.userId, end };

    function cleanup() {
      if (closed) return;
      closed = true;
      metrics.sseStreams(-1);
      clearInterval(heartbeat);
      clearTimeout(expiry);
      heartbeat = expiry = undefined;
      removeFrom(bySession, stream.sessionId, stream);
      removeFrom(byUser, stream.userId, stream);
      const u = unlisten;
      unlisten = null;
      if (u) void u().catch((err: unknown) => req.log.warn({ err }, 'sse unsubscribe failed'));
    }
    function end() {
      cleanup();
      res.end();
    }

    // Claim the slot and watch for the disconnect in the same tick. A client
    // that left while authentication ran has already emitted 'close', so
    // check for that too; nothing is allocated for it.
    addTo(bySession, stream.sessionId, stream);
    addTo(byUser, stream.userId, stream);
    metrics.sseStreams(1); // the matching -1 is in cleanup (runs once)
    res.on('close', cleanup);
    res.on('error', cleanup);
    if (res.destroyed || res.socket?.destroyed) {
      cleanup();
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);

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

    /** Ends the stream when the session reaches its expiry time. */
    function endAt(expiresAt: Date) {
      clearTimeout(expiry);
      const ms = expiresAt.getTime() - Date.now();
      if (ms <= 0) return end();
      expiry = setTimeout(() => endAt(expiresAt), Math.min(ms, MAX_TIMER_MS));
    }
    /** Same check as authentication (auth_resolve_session); ends the stream if it fails. */
    async function sessionStillValid(): Promise<boolean> {
      const s = await resolveSession(db, token);
      if (closed) return false;
      if (!s || s.sessionId !== stream.sessionId) {
        end();
        return false;
      }
      endAt(s.expiresAt);
      return true;
    }
    let checking = false;
    heartbeat = setInterval(() => {
      write(': heartbeat\n\n');
      if (closed || checking) return;
      checking = true;
      sessionStillValid()
        .catch((err: unknown) => {
          // Fail closed; the client reconnects and is authenticated afresh.
          req.log.warn({ err }, 'sse session check failed; ending stream');
          end();
        })
        .finally(() => (checking = false));
    }, heartbeatMs);

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
      // Session ends are heard from here on...
      await watchSessions();
      if (closed) return;
      // ...and events: subscribe before replaying so nothing committed in between is missed.
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
      // A session that ended between authentication and the watch above was
      // not announced to this stream; check it once now that a later end would be.
      if (!(await sessionStillValid())) return;

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
