/**
 * Appointments JARVIS booked or tried to book (docs/architecture/phase-c.md
 * §3.4, §3.8): read-only records written by the commerce module (exactly once
 * per step). Keyset pages ordered (created_at DESC, id DESC); every lookup is
 * RLS-scoped, so another user's booking is a 404.
 */
import type { FastifyInstance } from 'fastify';
import { withContext } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { notFound } from '../../lib/errors';
import type { AppDeps } from '../../services';
import { loadEvidenceByIds, pickEvidence } from '../evidence/mappers';
import { afterCursor, cursorTimestamp, decodeCursor, toPage } from '../home/cursor';
import { BOOKING_COLUMNS, bookingEvidenceIds, toBooking } from './mappers';

export function registerBookingRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'listBookings', async ({ ctx, query }) => {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    return withContext(db, ctx, async (trx) => {
      let b = trx
        .selectFrom('bookings as b')
        .select(BOOKING_COLUMNS.map((c) => `b.${c}` as const))
        .select(cursorTimestamp('b.created_at').as('cursor_ts'))
        .where('b.user_id', '=', ctx.userId);
      if (query.status) b = b.where('b.status', '=', query.status);
      if (cursor) b = b.where(afterCursor('b.created_at', 'b.id', cursor));
      const rows = await b
        .orderBy('b.created_at', 'desc')
        .orderBy('b.id', 'desc')
        .limit(query.limit + 1)
        .execute();
      const evidence = await loadEvidenceByIds(
        trx,
        rows.slice(0, query.limit).flatMap(bookingEvidenceIds),
      );
      return toPage(rows, query.limit, (r) =>
        toBooking(r, pickEvidence(evidence, bookingEvidenceIds(r))),
      );
    });
  });

  defineRoute(app, deps, 'getBooking', async ({ ctx, params }) => {
    const booking = await withContext(db, ctx, async (trx) => {
      const row = await trx
        .selectFrom('bookings')
        .select(BOOKING_COLUMNS)
        .where('id', '=', params.id)
        .executeTakeFirst();
      if (!row) return null;
      const evidence = await loadEvidenceByIds(trx, bookingEvidenceIds(row));
      return toBooking(row, pickEvidence(evidence, bookingEvidenceIds(row)));
    });
    if (!booking) throw notFound('Booking');
    return booking;
  });
}
