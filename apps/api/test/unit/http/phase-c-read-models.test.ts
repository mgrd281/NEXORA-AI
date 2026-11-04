/**
 * Phase C HTTP read models (orders, bookings, evidence, browser sessions)
 * produce exactly the contract shapes, keep internal columns out, and the
 * purchase-limit rule accepts whole cents only.
 */
import { describe, expect, it } from 'vitest';
import { Booking, BrowserSession, EvidenceArtifact, Order } from '@jarvis/contracts';
import type {
  BookingRow,
  BrowserSessionRow,
  EvidenceArtifactRow,
  OrderRow,
} from '../../../src/db/types';
import { isWholeCents } from '../../../src/modules/account/routes';
import { toBooking } from '../../../src/modules/bookings/mappers';
import {
  pickEvidence,
  toBrowserSession,
  toEvidenceArtifact,
} from '../../../src/modules/evidence/mappers';
import { evidenceFilename } from '../../../src/modules/evidence/routes';
import { failureReasonOf, orderEvidenceIds, toOrder } from '../../../src/modules/orders/mappers';
import { PENDING_ROUTES } from '../../../src/routes';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = new Date('2026-11-04T10:00:00.123Z');

const evidenceRow = (n: number): EvidenceArtifactRow => ({
  id: ID(n),
  tenant_id: ID(90),
  user_id: ID(91),
  task_id: ID(1),
  browser_session_id: ID(2),
  call_session_id: null,
  kind: 'screenshot',
  media_type: 'image/png',
  size_bytes: 1234,
  sha256: 'a'.repeat(64),
  storage_driver: 'local',
  storage_key: `tenants/${ID(90)}/users/${ID(91)}/evidence/${ID(n)}`,
  page_url: 'http://127.0.0.1:4599/shop/cart',
  created_at: at,
});

const orderRow = (over: Partial<OrderRow> = {}): OrderRow => ({
  id: ID(10),
  tenant_id: ID(90),
  user_id: ID(91),
  task_id: ID(1),
  step_id: ID(3),
  site_id: 'fixture-shop',
  merchant_name: 'Fixture Audio',
  merchant_host: '127.0.0.1:4599',
  idempotency_key: `order:${ID(3)}`,
  status: 'placed',
  items: [
    {
      title: 'FX-100',
      quantity: 2,
      unitPrice: { amountMicro: 79_000_000, currency: 'USD' },
      lineTotal: { amountMicro: 158_000_000, currency: 'USD' },
      productUrl: 'http://127.0.0.1:4599/shop/products/fx-100',
    },
  ],
  currency: 'USD',
  subtotal_micro: 158_000_000,
  shipping_micro: 0,
  tax_micro: 12_000_000,
  total_micro: 170_000_000,
  merchant_order_id: 'FX-9',
  placed_at: at,
  failure_reason: null,
  approval_id: ID(4),
  action_hash: 'h'.repeat(64),
  cart_artifact_id: ID(20),
  confirmation_artifact_id: ID(21),
  created_at: at,
  updated_at: at,
  ...over,
});

describe('Phase C read models', () => {
  it('maps an evidence row to the contract, without storage details', () => {
    const e = toEvidenceArtifact(evidenceRow(20));
    expect(EvidenceArtifact.parse(e)).toEqual(e);
    expect(e.downloadPath).toBe(`/v1/evidence/${ID(20)}/content`);
    expect(JSON.stringify(e)).not.toMatch(/storage|tenants\//);
  });

  it('maps an order (money in its currency, tax optional) and keeps internal columns out', () => {
    const cart = toEvidenceArtifact(evidenceRow(20));
    const o = toOrder(orderRow(), [cart]);
    expect(Order.parse(o)).toEqual(o);
    expect(o).toMatchObject({
      shipping: { amountMicro: 0, currency: 'USD' },
      tax: { amountMicro: 12_000_000, currency: 'USD' },
      total: { amountMicro: 170_000_000, currency: 'USD' },
      evidence: [cart],
    });
    expect(JSON.stringify(o)).not.toMatch(/idempotency|order:|hhhh|approval/);
    expect(orderEvidenceIds(orderRow())).toEqual([ID(20), ID(21)]);
    const untaxed = toOrder(orderRow({ tax_micro: null }), []);
    expect(untaxed.tax).toBeNull();
  });

  it('reads a stored failure reason only if the contract knows it', () => {
    expect(failureReasonOf('PRICE_CHANGED')).toBe('PRICE_CHANGED');
    expect(failureReasonOf('ORDER_UNKNOWN')).toBe('ORDER_UNKNOWN');
    expect(failureReasonOf('SOMETHING_NEW')).toBeNull();
    expect(failureReasonOf(null)).toBeNull();
    const failed = toOrder(
      orderRow({
        status: 'failed',
        failure_reason: 'OUT_OF_STOCK',
        merchant_order_id: null,
        placed_at: null,
      }),
      [],
    );
    expect(Order.parse(failed).failureReason).toBe('OUT_OF_STOCK');
  });

  it('maps a booking (price both-or-neither) to the contract', () => {
    const row: BookingRow = {
      id: ID(30),
      tenant_id: ID(90),
      user_id: ID(91),
      task_id: null,
      step_id: null,
      site_id: 'fixture-booking',
      site_name: 'Fixture Dental',
      site_host: '127.0.0.1:4599',
      service: 'Check-up',
      idempotency_key: `booking:${ID(3)}`,
      status: 'confirmed',
      slot_start: at,
      slot_end: null,
      time_zone: 'Europe/Berlin',
      reference: 'FXD-1',
      price_micro: null,
      price_currency: null,
      binding: false,
      calendar_event_id: 'evt-1',
      failure_reason: null,
      approval_id: null,
      action_hash: 'h'.repeat(64),
      slots_artifact_id: null,
      confirmation_artifact_id: null,
      ics_artifact_id: null,
      created_at: at,
      updated_at: at,
    };
    const b = toBooking(row, []);
    expect(Booking.parse(b)).toEqual(b);
    expect(b).toMatchObject({ price: null, end: null, calendarEventId: 'evt-1', taskId: null });
    const paid = toBooking(
      { ...row, price_micro: 45_000_000, price_currency: 'USD', binding: true },
      [],
    );
    expect(paid.price).toEqual({ amountMicro: 45_000_000, currency: 'USD' });
  });

  it('maps a browser session without its recipe request, result or worker id', () => {
    const row: BrowserSessionRow = {
      id: ID(2),
      tenant_id: ID(90),
      user_id: ID(91),
      task_id: ID(1),
      step_id: ID(3),
      status: 'handover',
      isolation_profile: 'ephemeral',
      site_id: 'fixture-shop',
      operation: 'search',
      idempotency_key: 'exec-key',
      request: { query: 'headphones' },
      result: null,
      stop_reason: 'LOGIN_REQUIRED',
      handover_url: 'http://127.0.0.1:4599/login-wall',
      navigations: 1,
      requests: 9,
      blocked_requests: 0,
      worker_id: 'bw-1',
      cancel_requested_at: null,
      started_at: at,
      ended_at: at,
      created_at: at,
      updated_at: at,
    };
    const s = toBrowserSession(row, []);
    expect(BrowserSession.parse(s)).toEqual(s);
    expect(JSON.stringify(s)).not.toMatch(/headphones|bw-1|exec-key|ephemeral/);
  });

  it('picks the files that still exist, in the order given, once each', () => {
    const a = toEvidenceArtifact(evidenceRow(20));
    const b = toEvidenceArtifact(evidenceRow(21));
    const byId = new Map([
      [a.id, a],
      [b.id, b],
    ]);
    expect(pickEvidence(byId, [b.id, null, ID(99), a.id, b.id])).toEqual([b, a]);
  });

  it('names downloads with fixed ASCII names (nothing from the page in a header)', () => {
    expect(evidenceFilename(ID(5), 'screenshot')).toBe(`jarvis-evidence-${ID(5)}.png`);
    expect(evidenceFilename(ID(5), 'extract')).toBe(`jarvis-evidence-${ID(5)}.json`);
    expect(evidenceFilename(ID(5), 'ics')).toBe(`jarvis-evidence-${ID(5)}.ics`);
  });

  it('accepts purchase limits in whole cents only', () => {
    for (const ok of [0, 1, 19.99, 149.99, 0.01, 10_000])
      expect(isWholeCents(ok), String(ok)).toBe(true);
    for (const bad of [12.345, 0.001, 10.005, Number.NaN, Number.POSITIVE_INFINITY])
      expect(isWholeCents(bad), String(bad)).toBe(false);
  });

  it('has no pending Phase C routes left (stage 2 complete; Phase D lists its own)', () => {
    const phaseC = new Set([
      'listConnectionProviders',
      'startOAuthConnection',
      'completeOAuthConnection',
      'listUpcomingEvents',
      'listCalendarEvents',
      'listEmailWatches',
      'deleteEmailWatch',
      'listOrders',
      'getOrder',
      'listBookings',
      'getBooking',
      'getEvidence',
      'downloadEvidence',
    ]);
    expect([...PENDING_ROUTES].filter((n) => phaseC.has(n))).toEqual([]);
  });
});
