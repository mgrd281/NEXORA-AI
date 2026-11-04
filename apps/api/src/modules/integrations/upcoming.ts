/**
 * Home "Upcoming" and the calendar list (docs/architecture/phase-c.md §3.3):
 * events are read live from every connection granting calendar.read, in
 * parallel, each bounded by a timeout — Home never fails because a calendar
 * is slow; each source reports ok | expired | scope_missing | unavailable.
 * Nothing is stored: the only cache is in memory, per connection, for
 * CALENDAR_LIMITS.upcomingCacheSeconds, dropped when the connection changes.
 */
import {
  CALENDAR_LIMITS,
  type CalendarEventList,
  type CalendarEventListQuery,
  type CalendarSource,
  type UpcomingEvents,
} from '@jarvis/contracts';
import { withContext, type DbContext } from '../../db/pool';
import type { ConnectionRow } from '../../db/types';
import { AppError } from '../../lib/errors';
import { effectiveTimeZone } from '../../lib/period';
import { AgentError } from '../agent/errors';
import { onConnectionChanged } from './bus';
import { calendarClient, toCalendarEvent, toEventSummary, type CalEvent } from './calendar';
import { PROVIDER_NAME, isOAuthProvider, type IntegrationDeps, type OAuthProvider } from './types';

type Status = CalendarSource['status'];

const cache = new Map<string, { at: number; key: string; events: CalEvent[] }>();
onConnectionChanged((id) => cache.delete(id));

/** For tests: forget every cached answer. */
export function clearUpcomingCache(): void {
  cache.clear();
}

async function calendarConnections(
  deps: IntegrationDeps,
  ctx: DbContext,
): Promise<{ rows: ConnectionRow[]; timeZone: string }> {
  return withContext(deps.db, ctx, async (trx) => {
    const rows = await trx
      .selectFrom('connections')
      .selectAll()
      .where('provider', 'in', ['google', 'microsoft'])
      .where('status', '<>', 'revoked')
      .orderBy('provider')
      .orderBy('created_at')
      .execute();
    const user = await trx
      .selectFrom('users')
      .select('time_zone')
      .where('id', '=', ctx.userId)
      .executeTakeFirst();
    const timeZone = await effectiveTimeZone(trx, user?.time_zone ?? 'UTC');
    // A connection counts while it holds calendar.read (an expired one too: Home shows "Reconnect").
    return { rows: rows.filter((r) => r.capabilities.includes('calendar.read')), timeZone };
  });
}

function statusOf(err: unknown): Status {
  if (err instanceof AgentError) {
    if (err.reason === 'CONNECTION_EXPIRED') return 'expired';
    if (err.reason === 'CONNECTION_SCOPE_MISSING') return 'scope_missing';
  }
  return 'unavailable';
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

async function readSource(
  deps: IntegrationDeps,
  ctx: DbContext,
  row: ConnectionRow,
  timeZone: string,
  range: { from: Date; to: Date; limit: number },
  timeoutMs: number,
  useCache: boolean,
): Promise<{ source: CalendarSource; events: CalEvent[]; truncated: boolean }> {
  const provider = row.provider as OAuthProvider;
  const base = { connectionId: row.id, provider, accountIdentifier: row.account_identifier };
  if (row.status === 'expired')
    return { source: { ...base, status: 'expired' }, events: [], truncated: false };
  if (row.status !== 'active')
    return { source: { ...base, status: 'unavailable' }, events: [], truncated: false };
  const key = `${new Date(row.updated_at).getTime()}:${range.from.getTime()}:${range.to.getTime()}:${range.limit}`;
  const hit = cache.get(row.id);
  if (
    useCache &&
    hit &&
    hit.key === key &&
    Date.now() - hit.at < CALENDAR_LIMITS.upcomingCacheSeconds * 1000
  )
    return { source: { ...base, status: 'ok' }, events: hit.events, truncated: false };
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const client = calendarClient(
      deps,
      ctx,
      { id: row.id, provider, accountIdentifier: row.account_identifier },
      timeZone,
    );
    const res = await withTimeout(client.list(range, signal), timeoutMs);
    if (useCache) cache.set(row.id, { at: Date.now(), key, events: res.events });
    return { source: { ...base, status: 'ok' }, events: res.events, truncated: res.truncated };
  } catch (err) {
    return { source: { ...base, status: statusOf(err) }, events: [], truncated: false };
  }
}

/**
 * HomeSnapshot.upcoming / GET /v1/calendar/upcoming: null when no connection
 * grants calendar.read (the section is then not shown at all).
 */
export async function upcomingEvents(
  deps: IntegrationDeps,
  ctx: DbContext,
  opts: { timeoutMs?: number; now?: Date } = {},
): Promise<UpcomingEvents | null> {
  const { rows, timeZone } = await calendarConnections(deps, ctx);
  if (rows.length === 0) return null;
  const now = opts.now ?? new Date();
  const from = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const to = new Date(from.getTime() + CALENDAR_LIMITS.upcomingDays * 86_400_000);
  const timeoutMs = opts.timeoutMs ?? CALENDAR_LIMITS.homeTimeoutMs;
  const results = await Promise.all(
    rows.map((r) =>
      readSource(
        deps,
        ctx,
        r,
        timeZone,
        { from, to, limit: CALENDAR_LIMITS.upcomingMax },
        timeoutMs,
        true,
      ),
    ),
  );
  const events = results
    .flatMap((r) => r.events)
    .filter((e) => new Date(e.end).getTime() > now.getTime())
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, CALENDAR_LIMITS.upcomingMax)
    .map(toEventSummary);
  return {
    events,
    sources: results.map((r) => r.source),
    rangeStart: from.toISOString(),
    rangeEnd: to.toISOString(),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * GET /v1/calendar/events: a window of at most CALENDAR_LIMITS.listMaxDays.
 * Throws AppError CONNECTION_REQUIRED (409) CALENDAR_NOT_CONNECTED, or
 * SERVICE_UNAVAILABLE (503) CALENDAR_UNAVAILABLE { provider } when the only
 * source failed.
 */
export async function listEvents(
  deps: IntegrationDeps,
  ctx: DbContext,
  q: CalendarEventListQuery,
): Promise<CalendarEventList> {
  const from = new Date(q.from);
  const to = new Date(q.to);
  if (
    !(to.getTime() > from.getTime()) ||
    to.getTime() - from.getTime() > CALENDAR_LIMITS.listMaxDays * 86_400_000
  )
    throw new AppError(
      'VALIDATION_FAILED',
      `“to” must be after “from” and at most ${CALENDAR_LIMITS.listMaxDays} days later.`,
    );
  const { rows, timeZone } = await calendarConnections(deps, ctx);
  const usable = rows.filter(
    (r) => (!q.provider || r.provider === q.provider) && isOAuthProvider(r.provider),
  );
  // Expired connections are reported as sources, but they alone do not make a calendar "connected".
  if (!usable.some((r) => r.status === 'active'))
    throw new AppError('CONNECTION_REQUIRED', 'No connected calendar can be read.', {
      reason: 'CALENDAR_NOT_CONNECTED',
    });
  const results = await Promise.all(
    usable.map((r) =>
      readSource(
        deps,
        ctx,
        r,
        timeZone,
        { from, to, limit: CALENDAR_LIMITS.listMaxEvents },
        CALENDAR_LIMITS.homeTimeoutMs * 4,
        false,
      ),
    ),
  );
  if (results.every((r) => r.source.status !== 'ok')) {
    // Name a source that did not answer (an expired one has its own fix: Reconnect).
    const provider = (
      results.find((r) => r.source.status === 'unavailable') ??
      results.find((r) => r.source.status !== 'expired') ??
      results[0]!
    ).source.provider;
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      `${PROVIDER_NAME[provider]} did not answer in time.`,
      {
        reason: 'CALENDAR_UNAVAILABLE',
        provider,
      },
    );
  }
  const all = results.flatMap((r) => r.events).sort((a, b) => a.start.localeCompare(b.start));
  return {
    items: all.slice(0, CALENDAR_LIMITS.listMaxEvents).map(toCalendarEvent),
    sources: results.map((r) => r.source),
    truncated: all.length > CALENDAR_LIMITS.listMaxEvents || results.some((r) => r.truncated),
  };
}
