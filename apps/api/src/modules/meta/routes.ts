/**
 * Time zones the server accepts (docs/architecture/phase-b.md §3.9): the
 * names Postgres knows (pg_timezone_names) that Node can also format (Intl),
 * without the posix/ and right/ trees, posixrules, localtime and Factory. These
 * are exactly the names updateMe and schedules store (canonicalTimeZone), so
 * a picker built from this list never offers a zone the server rejects.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { TimeZoneInfo } from '@jarvis/contracts';
import { withContext, type Trx } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { isValidTimeZone } from '../../lib/period';
import type { AppDeps } from '../../services';

const CACHE_MS = 3_600_000;
let cache: { items: TimeZoneInfo[]; loadedAt: number } | null = null;

const EXCLUDED = /^(posix|right)\/|^(posixrules|localtime|Factory)$/;

export async function loadTimeZones(trx: Trx, now = Date.now()): Promise<TimeZoneInfo[]> {
  if (cache && now - cache.loadedAt < CACHE_MS) return cache.items;
  const { rows } = await sql<{ name: string; offset_minutes: number }>`
    select name, (extract(epoch from utc_offset) / 60)::integer as offset_minutes
      from pg_timezone_names`.execute(trx);
  const seen = new Set<string>();
  const items = rows
    .filter((r) => !EXCLUDED.test(r.name) && isValidTimeZone(r.name))
    .filter((r) => (seen.has(r.name) ? false : (seen.add(r.name), true)))
    .map((r) => ({ id: r.name, utcOffsetMinutes: Number(r.offset_minutes) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  cache = { items, loadedAt: now };
  return items;
}

/** Test hook: forget the cached list. */
export function resetTimeZoneCache(): void {
  cache = null;
}

export function registerMetaRoutes(app: FastifyInstance, deps: AppDeps) {
  defineRoute(app, deps, 'listTimeZones', async ({ ctx, reply }) => {
    const items = await withContext(deps.db, ctx, (trx) => loadTimeZones(trx));
    reply.header('cache-control', 'private, max-age=3600');
    return { items };
  });
}
