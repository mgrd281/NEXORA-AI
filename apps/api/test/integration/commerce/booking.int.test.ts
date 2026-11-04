/**
 * Scenario 1 — booking an appointment on a supported site, end to end through
 * the agent with real Chromium against the fixture booking site: live slots
 * only (with a screenshot), the approval of the exact slot and every detail
 * sent, the confirmation read from the site (reference + ICS kept as
 * evidence, bookings row confirmed), a slot taken between planning and
 * approval (SLOT_TAKEN, the other free times offered again, nothing booked),
 * missing details asked for, a submission without confirmation
 * (BOOKING_UNCONFIRMED) and a paid booking under the purchase rules.
 */
import type { ApprovalDetails, BookingSlots } from '@jarvis/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withContext, type DbContext } from '../../../src/db/pool';
import { auditActions, connectWeb, detail, drain, newUser } from '../agent/harness';
import {
  artifactsOf,
  createBrowserHarness,
  sessionsOf,
  weekdayAhead,
  type BrowserHarness,
} from '../browser/harness';

let h: BrowserHarness;

beforeAll(async () => {
  h = await createBrowserHarness();
}, 60_000);
afterAll(() => h.close());
afterEach(async () => {
  await h.fixture.admin('/booking/admin/reset?rotation=off');
});

const DAY = weekdayAhead(3);
const SLOT_ID = `checkup-${DAY.replaceAll('-', '')}-1000`;
const REQUEST = `Book a check-up at Fixture Dental on ${DAY} at 10:00 for Alex Example, phone +49 30 1234567`;

async function patient() {
  const user = await newUser(h.db);
  await connectWeb(h.db, user);
  return user;
}

async function submit(user: DbContext, request: string) {
  const s = await h.services.tasks.create(user, { request, source: 'text' }, {});
  await drain(h.worker);
  return detail(h.db, user, s.id);
}

async function pendingApproval(user: DbContext, taskId: string) {
  return withContext(h.db, user, (trx) =>
    trx
      .selectFrom('approvals')
      .selectAll()
      .where('task_id', '=', taskId)
      .where('status', '=', 'PENDING')
      .executeTakeFirstOrThrow(),
  );
}

async function approve(user: DbContext, taskId: string) {
  const a = await pendingApproval(user, taskId);
  await h.services.approvals.decide(
    user,
    a.id,
    { decision: 'approve', actionHash: a.action_hash },
    'web',
  );
  await drain(h.worker);
  return detail(h.db, user, taskId);
}

const reservations = async () =>
  (await h.fixture.admin('/booking/admin/reservations', 'GET')) as {
    reservations: { ref: string; key: string; start: string; name: string; phone: string }[];
    bookAttempts: number;
  };

const bookingsOf = (user: DbContext) =>
  withContext(h.db, user, (trx) =>
    trx.selectFrom('bookings').selectAll().orderBy('created_at').execute(),
  );

beforeAll(async () => {
  await h.fixture.admin('/booking/admin/reset?rotation=off');
});

describe('scenario 1: book an appointment on a supported site', () => {
  it('reads live slots, asks with the exact slot and details, books once and keeps the confirmation', async () => {
    const user = await patient();
    const waiting = await submit(user, REQUEST);
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    expect(waiting.titleMessage).toEqual({
      key: 'plan.book',
      params: { service: 'Check-up', site: 'Fixture Dental' },
    });
    expect(waiting.steps.map((s) => [s.toolId, s.status])).toEqual([
      ['booking.find_slots', 'SUCCEEDED'],
      ['booking.book', 'AWAITING_APPROVAL'],
    ]);
    // The slot came from the live page, with a screenshot of the availability.
    const found = waiting.steps[0]!;
    expect(found.evidence.some((e) => e.code === 'SCREENSHOT')).toBe(true);
    const slotsOut = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('task_steps')
        .select('output')
        .where('id', '=', found.id)
        .executeTakeFirstOrThrow(),
    );
    const result = (slotsOut.output as { result: BookingSlots }).result;
    expect(result.slots.map((s) => s.id)).toEqual([SLOT_ID]);
    expect(result.requiredFields).toEqual(['Full name', 'Email', 'Phone']);

    const a = await pendingApproval(user, waiting.id);
    expect(a.risk_level).toBe('MEDIUM'); // free, cancellable any time
    const details = a.details as Extract<ApprovalDetails, { kind: 'booking' }>;
    expect(details).toMatchObject({
      kind: 'booking',
      siteId: 'fixture-booking',
      siteName: 'Fixture Dental',
      siteHost: `127.0.0.1:${h.fixture.port}`,
      service: 'Check-up',
      start: result.slots[0]!.start,
      end: result.slots[0]!.end,
      timeZone: 'Europe/Berlin',
      price: null,
      binding: false,
      cancellationTerms: 'Free of charge. You can cancel at any time.',
      fields: [
        { label: 'Full name', value: 'Alex Example', personal: true },
        { label: 'Email', value: user.email, personal: true },
        { label: 'Phone', value: '+49 30 1234567', personal: true },
      ],
    });
    expect(details.evidenceArtifactId).toBeTruthy();
    expect(a.summary_message).toEqual({
      key: 'approval.booking',
      params: { service: 'Check-up', site: 'Fixture Dental' },
    });

    const done = await approve(user, waiting.id);
    expect(done.status).toBe('COMPLETED');
    const site = await reservations();
    expect(site.reservations).toHaveLength(1);
    const reference = site.reservations[0]!.ref;
    expect(site.reservations[0]).toMatchObject({
      name: 'Alex Example',
      phone: '+49 30 1234567',
      start: result.slots[0]!.start,
    });
    expect(done.resultSummaryMessage).toEqual({
      key: 'result.booked',
      params: { service: 'Check-up', site: 'Fixture Dental', reference },
    });
    const book = done.steps[1]!;
    expect(book.evidence.find((e) => e.code === 'BOOKING_CONFIRMATION')?.params).toMatchObject({
      reference,
    });
    expect(book.evidence.some((e) => e.code === 'ICS_FILE')).toBe(true);
    const [row] = await bookingsOf(user);
    expect(row).toMatchObject({
      status: 'confirmed',
      reference,
      site_id: 'fixture-booking',
      service: 'Check-up',
      time_zone: 'Europe/Berlin',
      binding: false,
      idempotency_key: `booking:${book.id}`,
      approval_id: a.id,
      action_hash: a.action_hash,
    });
    expect(row!.slot_start.toISOString()).toBe(result.slots[0]!.start);
    // The ICS confirmation is stored as evidence (text/calendar) for the same appointment.
    const ics = (await artifactsOf(h, user, done.id)).find((x) => x.kind === 'ics')!;
    expect(row!.ics_artifact_id).toBe(ics.id);
    const file = h.evidence.objects.get(ics.storage_key)!;
    expect(file.contentType).toBe('text/calendar');
    expect(file.body.toString()).toContain(`UID:${reference}@fixture-dental.test`);
    expect(await auditActions(user.userId)).toContain('booking.confirmed');
    // The booking output fields calendar.create_event references (frozen).
    const full = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('task_steps')
        .select('output')
        .where('id', '=', book.id)
        .executeTakeFirstOrThrow(),
    );
    expect(full.output).toMatchObject({
      bookingId: row!.id,
      reference,
      title: 'Check-up — Fixture Dental',
      start: result.slots[0]!.start,
      end: result.slots[0]!.end,
      timeZone: 'Europe/Berlin',
      location: 'Fixture Dental, 3 Molar Lane, 10117 Fixture City',
    });
  });

  it('a slot taken between planning and approval: SLOT_TAKEN, other free times offered, nothing booked', async () => {
    const user = await patient();
    const waiting = await submit(user, REQUEST);
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    await h.fixture.admin(`/booking/admin/take/${SLOT_ID}`); // someone else books it meanwhile
    const done = await approve(user, waiting.id);
    expect(done.status).toBe('FAILED');
    expect(done.error).toMatchObject({
      code: 'TOOL_FAILED',
      reason: 'SLOT_TAKEN',
      retryable: false,
    });
    expect(done.error!.message).toMatch(/Free now: /); // re-offered from the live page
    expect(Number(done.error!.params?.alternatives)).toBeGreaterThan(0);
    const bookSession = (await sessionsOf(h, user, done.id)).find((s) => s.operation === 'book')!;
    const offered = bookSession.result as { outcome: string; slots: { id: string }[] };
    expect(offered.outcome).toBe('slot_taken');
    expect(offered.slots.length).toBeGreaterThan(0);
    expect(offered.slots.map((s) => s.id)).not.toContain(SLOT_ID);
    expect((await bookingsOf(user)).map((b) => [b.status, b.failure_reason])).toEqual([
      ['failed', 'SLOT_TAKEN'],
    ]);
    expect((await reservations()).reservations).toEqual([]);
  });

  it('only live availability: a slot already taken is never offered', async () => {
    const user = await patient();
    await h.fixture.admin(`/booking/admin/take/${SLOT_ID}`);
    const d = await submit(user, REQUEST);
    expect(d.status).toBe('FAILED');
    expect(d.error).toMatchObject({ reason: 'NO_FREE_SLOTS' });
    expect(d.steps[1]!.status).toBe('SKIPPED');
    expect(await bookingsOf(user)).toEqual([]);
  });

  it('missing details are asked for, and the answer completes the booking request', async () => {
    const user = await patient();
    const asked = await submit(user, `Book a check-up at Fixture Dental on ${DAY} at 10:00`);
    expect(asked.status).toBe('COMPLETED');
    expect(asked.outcome).toBe('question');
    expect(asked.question?.missing).toEqual(['contact_details']);
    const s = await h.services.tasks.followUp(
      user,
      asked.conversationId,
      { request: 'Alex Example, +49 30 1234567', source: 'text' },
      {},
    );
    await drain(h.worker);
    const waiting = await detail(h.db, user, s.id);
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    const a = await pendingApproval(user, s.id);
    expect(
      (a.details as Extract<ApprovalDetails, { kind: 'booking' }>).fields.map((f) => f.value),
    ).toEqual(['Alex Example', user.email, '+49 30 1234567']);
  });

  it('submitted without a confirmation page → OUTCOME_UNKNOWN (BOOKING_UNCONFIRMED), never assumed booked', async () => {
    const user = await patient();
    const waiting = await submit(user, REQUEST);
    await h.fixture.admin('/booking/admin/mode?confirm=none');
    const done = await approve(user, waiting.id);
    expect(done.status).toBe('FAILED');
    expect(done.error).toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      reason: 'BOOKING_UNCONFIRMED',
      retryable: false,
    });
    expect((await bookingsOf(user)).map((b) => [b.status, b.failure_reason, b.reference])).toEqual([
      ['unknown', 'BOOKING_UNCONFIRMED', null],
    ]);
  });

  it('a paid booking is a purchase: refused while purchases are off (PURCHASES_DISABLED)', async () => {
    const user = await patient();
    const d = await submit(
      user,
      `Book a dental cleaning at Fixture Dental on ${DAY} at 10:00 for Alex Example, phone +49 30 1234567`,
    );
    expect(d.status).toBe('FAILED');
    expect(d.error).toMatchObject({ code: 'POLICY_DENIED', reason: 'PURCHASES_DISABLED' });
    expect(d.steps.map((s) => [s.toolId, s.status])).toEqual([
      ['booking.find_slots', 'SUCCEEDED'],
      ['booking.book', 'BLOCKED'],
    ]);
    expect((await reservations()).reservations).toEqual([]);
  });

  it('a paid, binding booking within the limit is HIGH with BINDING_COMMITMENT and PURCHASE', async () => {
    const user = await newUser(h.db, {
      spending: { monthlyAiBudgetUsd: 20, monthlyPurchaseLimitUsd: 200 },
    });
    await connectWeb(h.db, user);
    const waiting = await submit(
      user,
      `Book a dental cleaning at Fixture Dental on ${DAY} at 10:00 for Alex Example, phone +49 30 1234567`,
    );
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    const a = await pendingApproval(user, waiting.id);
    expect(a.risk_level).toBe('HIGH');
    expect(a.reasons).toEqual(
      expect.arrayContaining(['RISK_HIGH', 'BINDING_COMMITMENT', 'PURCHASE']),
    );
    expect(a.details).toMatchObject({
      kind: 'booking',
      binding: true,
      price: { amountMicro: 80_000_000, currency: 'USD' },
      cancellationTerms:
        'Cancellations less than 24 hours before the appointment are charged in full.',
    });
    const done = await approve(user, waiting.id);
    expect(done.status).toBe('COMPLETED');
    expect(
      (await bookingsOf(user)).map((b) => [b.status, b.binding, b.price_micro, b.price_currency]),
    ).toEqual([['confirmed', true, 80_000_000, 'USD']]);
  });
});
