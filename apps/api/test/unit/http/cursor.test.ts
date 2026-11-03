import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/lib/errors';
import {
  decodeCursor,
  encodeCursor,
  isMicrosecondIso,
  toPage,
} from '../../../src/modules/home/cursor';

const ID = '5f0c7a5e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const TS = '2026-11-03T15:04:05.123456Z';

describe('cursor encoding', () => {
  it('round-trips position with microsecond precision', () => {
    const c = encodeCursor({ t: TS, i: ID });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe, opaque
    expect(c).not.toContain(ID);
    expect(decodeCursor(c)).toEqual({ t: TS, i: ID });
  });

  it('fits the 200-character query limit', () => {
    expect(encodeCursor({ t: TS, i: ID }).length).toBeLessThan(200);
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['empty', ''],
    ['json array', Buffer.from('[1,2]').toString('base64url')],
    ['missing id', Buffer.from(JSON.stringify({ t: TS })).toString('base64url')],
    ['bad id', Buffer.from(JSON.stringify({ t: TS, i: 'x' })).toString('base64url')],
    [
      'millisecond timestamp',
      Buffer.from(JSON.stringify({ t: '2026-11-03T15:04:05.123Z', i: ID })).toString('base64url'),
    ],
    [
      'impossible date',
      Buffer.from(JSON.stringify({ t: '2026-02-30T00:00:00.000000Z', i: ID })).toString(
        'base64url',
      ),
    ],
    [
      'sql in timestamp',
      Buffer.from(JSON.stringify({ t: "2026'); drop table tasks; --", i: ID })).toString(
        'base64url',
      ),
    ],
  ])('rejects a %s cursor with VALIDATION_FAILED', (_name, cursor) => {
    let err: unknown;
    try {
      decodeCursor(cursor);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('VALIDATION_FAILED');
    expect((err as AppError).status).toBe(400);
  });
});

describe('isMicrosecondIso', () => {
  it('accepts only exact UTC microsecond timestamps of real dates', () => {
    expect(isMicrosecondIso(TS)).toBe(true);
    expect(isMicrosecondIso('2024-02-29T23:59:59.999999Z')).toBe(true); // leap day
    expect(isMicrosecondIso('2026-02-29T00:00:00.000000Z')).toBe(false);
    expect(isMicrosecondIso('2026-11-03T15:04:05.123456+01:00')).toBe(false);
    expect(isMicrosecondIso('2026-11-03 15:04:05.123456Z')).toBe(false);
    expect(isMicrosecondIso('2026-13-03T15:04:05.123456Z')).toBe(false);
  });
});

describe('toPage', () => {
  const row = (n: number) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    cursor_ts: `2026-11-03T15:04:${String(59 - n).padStart(2, '0')}.000001Z`,
    n,
  });

  it('uses the extra row only to detect a next page', () => {
    const rows = [row(1), row(2), row(3)];
    const page = toPage(rows, 2, (r) => r.n);
    expect(page.items).toEqual([1, 2]);
    expect(decodeCursor(page.nextCursor!)).toEqual({ t: rows[1]!.cursor_ts, i: rows[1]!.id });
  });

  it('has no next cursor on the last page', () => {
    expect(toPage([row(1), row(2)], 2, (r) => r.n)).toEqual({ items: [1, 2], nextCursor: null });
    expect(toPage([], 25, (r: ReturnType<typeof row>) => r.n)).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});
