/**
 * Keyset pagination shared by the v1 list endpoints (tasks, memories,
 * notifications). A cursor is an opaque base64url token holding the last
 * row's (created_at, id). created_at travels as text with microsecond
 * precision — JavaScript Dates only keep milliseconds, which would skip or
 * repeat rows created within the same millisecond.
 *
 * Lists are ordered (created_at DESC, id DESC); the next page holds the rows
 * strictly after the cursor in that order.
 */
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { AppError } from '../../lib/errors';

const MICROS_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/**
 * Every stored row is newer than this. It also keeps tampered cursors inside
 * the range Postgres accepts: JavaScript round-trips year 0000, timestamptz rejects it.
 */
const MIN_YEAR = 1970;

/**
 * True for a real UTC instant in the exact `YYYY-MM-DDTHH:MM:SS.ffffffZ` form,
 * in the years 1970–9999.
 */
export function isMicrosecondIso(value: string): boolean {
  if (!MICROS_ISO.test(value)) return false;
  if (Number(value.slice(0, 4)) < MIN_YEAR) return false;
  // Round-trip the millisecond prefix so impossible dates (Feb 30) are rejected.
  const ms = `${value.slice(0, 23)}Z`;
  const d = new Date(ms);
  return !Number.isNaN(d.getTime()) && d.toISOString() === ms;
}

const Position = z.object({
  t: z.string().refine(isMicrosecondIso),
  i: z.uuid(),
});
export type CursorPosition = z.infer<typeof Position>;

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify({ t: position.t, i: position.i }), 'utf8').toString(
    'base64url',
  );
}

/** Decodes a client-supplied cursor; anything malformed is a VALIDATION_FAILED error. */
export function decodeCursor(cursor: string): CursorPosition {
  let raw: unknown = null;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    raw = null;
  }
  const parsed = Position.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Invalid cursor');
  return parsed.data;
}

/** Renders a timestamptz column as the cursor's exact UTC text (microseconds). */
export function cursorTimestamp(column: string): RawBuilder<string> {
  return sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Row-value predicate selecting rows after the cursor in (created_at DESC, id DESC) order. */
export function afterCursor(
  createdAtColumn: string,
  idColumn: string,
  position: CursorPosition,
): RawBuilder<boolean> {
  return sql<boolean>`(${sql.ref(createdAtColumn)}, ${sql.ref(idColumn)}) < (${position.t}::timestamptz, ${position.i}::uuid)`;
}

/**
 * Turns `limit + 1` fetched rows into a page: the extra row only signals that
 * another page exists; the cursor points at the last row actually returned.
 */
export function toPage<R extends { cursor_ts: string; id: string }, T>(
  rows: readonly R[],
  limit: number,
  map: (row: R) => T,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(map),
    nextCursor: hasMore && last ? encodeCursor({ t: last.cursor_ts, i: last.id }) : null,
  };
}
