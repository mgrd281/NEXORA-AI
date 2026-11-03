import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types';

/*
 * Time zones are interpreted in two places: Postgres computes budget periods
 * (`now() at time zone …`) and Node formats dates (Intl, e.g. the planner's
 * "Today"). The two ship different zone databases: ICU keeps legacy names
 * such as Asia/Calcutta that some tzdata builds of Postgres drop, and
 * Postgres knows names ICU does not (Factory, posixrules). A zone is only
 * usable when both understand it.
 */

const ZONE_SHAPE = /^[A-Za-z]+(?:[/_+-][A-Za-z0-9]+)*$/;
const INTL_ZONES = new Set(Intl.supportedValuesOf('timeZone'));

/**
 * Whether Node can format dates in `tz`. Intl.supportedValuesOf lists
 * canonical names only (it omits "UTC" and aliases such as Asia/Kolkata on
 * some ICU builds), so well-formed names Intl can actually format with are
 * accepted too. Says nothing about Postgres: see canonicalTimeZone.
 */
export function isValidTimeZone(tz: string): boolean {
  if (tz === 'UTC' || INTL_ZONES.has(tz)) return true;
  if (!ZONE_SHAPE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Postgres's zone names (lower case → as Postgres spells it), reloaded hourly. */
let pgZones: { names: Map<string, string>; loadedAt: number } | null = null;
const PG_ZONES_TTL_MS = 3_600_000;

/**
 * The name Postgres uses for `tz` (matched without regard to case, as Postgres
 * itself matches zone names), or null when Postgres does not know it. Only
 * ever runs a SELECT that cannot fail on bad input, so it is safe inside a
 * caller's transaction. The list of names (pg_timezone_names reads the tzdata
 * directory, ~5 ms) is cached per process.
 */
export async function resolveTimeZone(db: Kysely<Database>, tz: string): Promise<string | null> {
  if (!pgZones || Date.now() - pgZones.loadedAt > PG_ZONES_TTL_MS) {
    const { rows } = await sql<{ name: string }>`select name from pg_timezone_names`.execute(db);
    pgZones = {
      names: new Map(rows.map((r) => [r.name.toLowerCase(), r.name])),
      loadedAt: Date.now(),
    };
  }
  return pgZones.names.get(tz.toLowerCase()) ?? null;
}

/**
 * The spelling to store for a zone the user chose: Postgres's name for it,
 * provided Node can use that name too. null when either rejects it.
 */
export async function canonicalTimeZone(db: Kysely<Database>, tz: string): Promise<string | null> {
  if (!isValidTimeZone(tz)) return null;
  const name = await resolveTimeZone(db, tz);
  return name && isValidTimeZone(name) ? name : null;
}

/**
 * The zone to compute with for a stored zone: its canonical name, or UTC when
 * Postgres or Node cannot use it (rows stored before zones were validated).
 */
export async function effectiveTimeZone(db: Kysely<Database>, tz: string): Promise<string> {
  return (await canonicalTimeZone(db, tz)) ?? 'UTC';
}

/**
 * The current calendar month in the user's time zone, as absolute instants.
 * Budgets, usage and cost reports all use this one definition, so what the
 * Policy Engine enforces is exactly what the user sees in Settings.
 * Falls back to UTC for a zone that is not usable (effectiveTimeZone). The
 * zone is resolved first rather than tried: inside a transaction a failed
 * statement would abort the caller's whole transaction, not just this query.
 */
export async function currentMonth(
  db: Kysely<Database>,
  timeZone: string,
): Promise<{ start: Date; end: Date }> {
  const tz = await effectiveTimeZone(db, timeZone);
  const res = await sql<{ start: Date; end: Date }>`
    select date_trunc('month', now() at time zone ${tz}) at time zone ${tz} as start,
           (date_trunc('month', now() at time zone ${tz}) + interval '1 month') at time zone ${tz} as end`.execute(
    db,
  );
  const row = res.rows[0]!;
  return { start: new Date(row.start), end: new Date(row.end) };
}
