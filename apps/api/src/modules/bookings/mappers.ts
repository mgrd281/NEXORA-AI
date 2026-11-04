/**
 * Booking rows → contract (docs/architecture/phase-c.md §3.4, §4.5). Shared by
 * the bookings routes and the account export. Idempotency keys, action hashes
 * and approval ids are internal.
 */
import type { Booking, EvidenceArtifact } from '@jarvis/contracts';
import type { BookingRow } from '../../db/types';
import { failureReasonOf } from '../orders/mappers';

export const BOOKING_COLUMNS = [
  'id',
  'task_id',
  'site_id',
  'site_name',
  'site_host',
  'service',
  'status',
  'slot_start',
  'slot_end',
  'time_zone',
  'reference',
  'price_micro',
  'price_currency',
  'binding',
  'calendar_event_id',
  'failure_reason',
  'slots_artifact_id',
  'confirmation_artifact_id',
  'ics_artifact_id',
  'created_at',
  'updated_at',
] as const;

export type BookingView = Pick<BookingRow, (typeof BOOKING_COLUMNS)[number]>;

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/** The evidence files of a booking, in display order: the slots, the confirmation, the ICS file. */
export const bookingEvidenceIds = (r: BookingView): (string | null)[] => [
  r.slots_artifact_id,
  r.confirmation_artifact_id,
  r.ics_artifact_id,
];

export function toBooking(r: BookingView, evidence: readonly EvidenceArtifact[]): Booking {
  return {
    id: r.id,
    taskId: r.task_id,
    siteId: r.site_id,
    siteName: r.site_name,
    siteHost: r.site_host,
    service: r.service,
    status: r.status,
    start: new Date(r.slot_start).toISOString(),
    end: iso(r.slot_end),
    timeZone: r.time_zone,
    reference: r.reference,
    // Both or neither (bookings_price CHECK).
    price:
      r.price_micro !== null && r.price_currency !== null
        ? { amountMicro: Number(r.price_micro), currency: r.price_currency }
        : null,
    binding: r.binding,
    calendarEventId: r.calendar_event_id,
    failureReason: failureReasonOf(r.failure_reason),
    evidence: [...evidence],
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
