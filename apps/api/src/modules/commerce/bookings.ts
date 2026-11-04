/**
 * Appointments booked by booking.book on supported sites — exactly once
 * (docs/adr/0018, docs/architecture/phase-c.md §3.4). Same pattern as orders:
 * the row is inserted before the form is submitted (status 'submitting', key
 * `booking:<step id>`, which is also the site's Idempotency-Key), a unique
 * violation means "this already happened — read it", and an interrupted
 * submission is 'unknown' (BOOKING_UNCONFIRMED) until it is reconciled with
 * the site by the same key.
 *
 * Transitions (conditional UPDATEs — safe to call twice):
 *   submitting → confirmed   the site's confirmation (reference; schema.org Reservation / ICS)
 *   submitting → failed      definitely not booked (slot taken, details missing, stopped before
 *                            submitting)
 *   submitting → unknown     submitted, but no confirmation was read
 *   unknown    → confirmed   reconciliation found the reservation
 *   failed / unknown → submitting   a retry (restartBooking)
 * The calendar entry made for a confirmed booking afterwards (calendar.create_event with
 * sourceBookingId — integrations) is linked with recordBookingCalendarEvent.
 */
import type { TaskErrorReason } from '@jarvis/contracts';
import type { DbContext, Trx } from '../../db/pool';
import type { BookingRow } from '../../db/types';
import { audit } from '../audit/audit';
import { appendEvent } from '../events/events';

export const bookingKey = (stepId: string): string => `booking:${stepId}`;

export interface BookingFacts {
  taskId: string | null;
  stepId: string | null;
  siteId: string;
  siteName: string;
  siteHost: string;
  service: string;
  slotStart: string;
  slotEnd: string | null;
  timeZone: string;
  priceMicro: number | null;
  priceCurrency: string | null;
  binding: boolean;
  approvalId: string | null;
  actionHash: string;
  slotsArtifactId: string | null;
}

export type BookingOutcome =
  | {
      kind: 'confirmed';
      reference: string;
      slotStart?: string;
      slotEnd?: string | null;
      confirmationArtifactId: string | null;
      icsArtifactId: string | null;
    }
  | { kind: 'failed'; reason: TaskErrorReason }
  | { kind: 'unknown' };

async function changed(trx: Trx, ctx: DbContext, row: BookingRow): Promise<void> {
  await appendEvent(trx, ctx, {
    taskId: row.task_id,
    type: 'booking.changed',
    data: { bookingId: row.id, taskId: row.task_id, status: row.status },
  });
}

/** Inserts the booking for `key` (submitting), or returns the existing one locked FOR UPDATE. */
export async function reserveBooking(
  trx: Trx,
  ctx: DbContext,
  key: string,
  f: BookingFacts,
): Promise<{ row: BookingRow; existing: boolean }> {
  const inserted = await trx
    .insertInto('bookings')
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      task_id: f.taskId,
      step_id: f.stepId,
      site_id: f.siteId,
      site_name: f.siteName.slice(0, 200),
      site_host: f.siteHost.slice(0, 255),
      service: f.service.slice(0, 300),
      idempotency_key: key,
      slot_start: new Date(f.slotStart),
      slot_end: f.slotEnd ? new Date(f.slotEnd) : null,
      time_zone: f.timeZone,
      price_micro: f.priceMicro,
      price_currency: f.priceMicro === null ? null : f.priceCurrency,
      binding: f.binding,
      approval_id: f.approvalId,
      action_hash: f.actionHash,
      slots_artifact_id: f.slotsArtifactId,
    })
    .onConflict((oc) => oc.columns(['user_id', 'idempotency_key']).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) {
    await changed(trx, ctx, inserted);
    return { row: inserted, existing: false };
  }
  const row = await trx
    .selectFrom('bookings')
    .selectAll()
    .where('idempotency_key', '=', key)
    .forUpdate()
    .executeTakeFirstOrThrow();
  return { row, existing: true };
}

/** A retry of a failed or unconfirmed booking: back to submitting with the facts now approved. */
export async function restartBooking(
  trx: Trx,
  ctx: DbContext,
  row: BookingRow,
  f: BookingFacts,
): Promise<BookingRow> {
  const updated = await trx
    .updateTable('bookings')
    .set({
      status: 'submitting',
      failure_reason: null,
      slot_start: new Date(f.slotStart),
      slot_end: f.slotEnd ? new Date(f.slotEnd) : null,
      time_zone: f.timeZone,
      price_micro: f.priceMicro,
      price_currency: f.priceMicro === null ? null : f.priceCurrency,
      binding: f.binding,
      approval_id: f.approvalId,
      action_hash: f.actionHash,
      slots_artifact_id: f.slotsArtifactId,
    })
    .where('id', '=', row.id)
    .where('status', 'in', ['failed', 'unknown'])
    .returningAll()
    .executeTakeFirst();
  if (!updated) return row;
  await changed(trx, ctx, updated);
  return updated;
}

/** Records what happened to the booking for `key` (idempotent; see the transitions above). */
export async function finalizeBooking(
  trx: Trx,
  ctx: DbContext,
  key: string,
  outcome: BookingOutcome,
): Promise<BookingRow | null> {
  const from: BookingRow['status'][] =
    outcome.kind === 'confirmed' ? ['submitting', 'unknown'] : ['submitting'];
  const set =
    outcome.kind === 'confirmed'
      ? {
          status: 'confirmed' as const,
          reference: outcome.reference.slice(0, 200),
          failure_reason: null,
          confirmation_artifact_id: outcome.confirmationArtifactId,
          ics_artifact_id: outcome.icsArtifactId,
          ...(outcome.slotStart ? { slot_start: new Date(outcome.slotStart) } : {}),
          ...(outcome.slotEnd ? { slot_end: new Date(outcome.slotEnd) } : {}),
        }
      : outcome.kind === 'failed'
        ? { status: 'failed' as const, failure_reason: outcome.reason }
        : { status: 'unknown' as const, failure_reason: 'BOOKING_UNCONFIRMED' };
  const updated = await trx
    .updateTable('bookings')
    .set(set)
    .where('idempotency_key', '=', key)
    .where('status', 'in', from)
    .returningAll()
    .executeTakeFirst();
  if (!updated)
    return (
      (await trx
        .selectFrom('bookings')
        .selectAll()
        .where('idempotency_key', '=', key)
        .executeTakeFirst()) ?? null
    );
  await changed(trx, ctx, updated);
  if (updated.status === 'confirmed') {
    await audit(trx, {
      tenantId: ctx.tenantId,
      actorType: 'agent',
      actorId: ctx.userId,
      action: 'booking.confirmed',
      targetType: 'booking',
      targetId: updated.id,
      metadata: { siteId: updated.site_id, binding: updated.binding, taskId: updated.task_id },
    });
  }
  return updated;
}

export async function bookingByKey(trx: Trx, key: string): Promise<BookingRow | null> {
  return (
    (await trx
      .selectFrom('bookings')
      .selectAll()
      .where('idempotency_key', '=', key)
      .executeTakeFirst()) ?? null
  );
}

/**
 * Links the calendar entry made for a confirmed booking (calendar.create_event
 * with sourceBookingId, docs/architecture/phase-c.md §4.5). RLS scopes it to the
 * caller's own bookings; only a confirmed booking gets one, and an existing link
 * is replaced only by the same id (idempotent for a retried step). Throws when
 * the booking is not this user's confirmed booking.
 */
export async function recordBookingCalendarEvent(
  trx: Trx,
  ctx: DbContext,
  bookingId: string,
  calendarEventId: string,
): Promise<void> {
  const id = calendarEventId.trim();
  if (id.length < 1 || id.length > 1024) throw new Error('invalid calendar event id');
  const row = await trx
    .selectFrom('bookings')
    .selectAll()
    .where('id', '=', bookingId)
    .forUpdate()
    .executeTakeFirst();
  if (!row || row.status !== 'confirmed') throw new Error('booking not found or not confirmed');
  if (row.calendar_event_id === id) return;
  const updated = await trx
    .updateTable('bookings')
    .set({ calendar_event_id: id })
    .where('id', '=', bookingId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await changed(trx, ctx, updated);
}
