/**
 * The purchase limit's month, as the server counts it (agent/context.ts monthlyPurchaseSpend,
 * view committed_purchases of migration 0006): orders submitting, placed or of unknown outcome,
 * and paid bookings submitting, confirmed or of unknown outcome, in USD, created since the start
 * of the current calendar month in the account's time zone. Pure — unit-tested in
 * test/phase-c.test.ts. The server stays the authority (the purchase approval carries its own
 * figures).
 */
import type { Booking, Money, Order } from '@jarvis/contracts';

const COMMITTED: ReadonlySet<Order['status']> = new Set(['submitting', 'placed', 'unknown']);
const COMMITTED_BOOKING: ReadonlySet<Booking['status']> = new Set([
  'submitting',
  'confirmed',
  'unknown',
]);

/** The instant the current calendar month began in `timeZone`. */
export function monthStart(now: number, timeZone: string | undefined): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(now));
  } catch {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // Wall-clock time now in the zone, minus how far into the month it is.
  const wall = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  const offset = wall - Math.floor(now / 1000) * 1000;
  return Date.UTC(get('year'), get('month') - 1, 1) - offset;
}

export function committedThisMonth(
  orders: readonly Pick<Order, 'status' | 'total' | 'createdAt'>[],
  timeZone: string | undefined,
  now: number,
  bookings: readonly Pick<Booking, 'status' | 'price' | 'createdAt'>[] = [],
): Money {
  const start = monthStart(now, timeZone);
  let micro = 0;
  for (const o of orders) {
    if (!COMMITTED.has(o.status) || o.total.currency !== 'USD') continue;
    if (Date.parse(o.createdAt) >= start) micro += o.total.amountMicro;
  }
  for (const b of bookings) {
    if (!b.price || !COMMITTED_BOOKING.has(b.status) || b.price.currency !== 'USD') continue;
    if (Date.parse(b.createdAt) >= start) micro += b.price.amountMicro;
  }
  return { amountMicro: micro, currency: 'USD' };
}
