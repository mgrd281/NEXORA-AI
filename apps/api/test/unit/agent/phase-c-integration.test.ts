/**
 * Phase C stage 3 (integration) fixes in the agent core: a German "what is in my
 * calendar" is a calendar question, not a document question; the booking intent
 * fills a form's "Full name" from the account's display name when the user writes
 * none (never inventing a phone number); paid bookings and a step's own committed
 * order are handled by the purchase limit as the executor computes it.
 */
import { describe, expect, it } from 'vitest';
import { planOffline, type OfflinePlanContext } from '../../../src/modules/agent/models/offline';
import type { ConnectionState } from '../../../src/modules/agent/tools/types';

const OWN = 'me@example.com';
const google: ConnectionState = {
  connectionId: '00000000-0000-0000-0000-000000000001',
  provider: 'google',
  status: 'active',
  capabilities: ['calendar.read'],
  accountIdentifier: 'me@gmail.test',
};

const ctx = (extra: Partial<OfflinePlanContext> = {}): OfflinePlanContext => ({
  language: 'de',
  ownEmail: OWN,
  timeZone: 'Europe/Berlin',
  connections: [google],
  browserAvailable: true,
  ...extra,
});

describe('documents vs. calendar (offline planner)', () => {
  it('"Was steht in meinem Kalender morgen?" lists the calendar', () => {
    const r = planOffline('Was steht in meinem Kalender morgen?', ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.steps.map((s) => s.toolId)).toEqual(['calendar.list']);
  });

  it('"Was steht in dem Dokument?" without a file still asks for the document', () => {
    const r = planOffline('Was steht in dem Dokument?', ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.steps.map((s) => s.toolId)).toEqual(['assistant.clarify']);
    expect(r.plan.steps[0]!.input).toMatchObject({ missing: ['document'] });
  });

  it('"what is in this file" is a document question in English too', () => {
    const r = planOffline('What is in this file?', { ...ctx(), language: 'en' });
    expect(r.ok && r.plan.steps[0]!.input).toMatchObject({ missing: ['document'] });
  });
});

describe('booking intent: the account name fills "Full name"', () => {
  const request = 'Book a check-up at Fixture Dental on 2026-11-12 at 10:00, phone +49 30 1234567';

  it('uses ownName when the request names nobody', () => {
    const r = planOffline(request, { ...ctx(), language: 'en', ownName: 'Alex Example' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const book = r.plan.steps.find((s) => s.toolId === 'booking.book');
    expect(book?.input).toMatchObject({
      details: { 'Full name': 'Alex Example', Email: OWN, Phone: '+49 30 1234567' },
    });
  });

  it('the name the user writes wins over the account name', () => {
    const r = planOffline(`${request} for Sam Other`, {
      ...ctx(),
      language: 'en',
      ownName: 'Alex Example',
    });
    const book = r.ok ? r.plan.steps.find((s) => s.toolId === 'booking.book') : null;
    expect(book?.input).toMatchObject({ details: { 'Full name': 'Sam Other' } });
  });

  it('never invents a phone number: still asks for contact details', () => {
    const r = planOffline('Book a check-up at Fixture Dental on 2026-11-12 at 10:00', {
      ...ctx(),
      language: 'en',
      ownName: 'Alex Example',
    });
    expect(r.ok && r.plan.steps.map((s) => s.toolId)).toEqual(['assistant.clarify']);
    expect(r.ok && r.plan.steps[0]!.input).toMatchObject({ missing: ['contact_details'] });
  });
});

describe('"email me via Gmail": the account the user names sends it', () => {
  const send = (request: string, language: 'en' | 'de' | 'ar' = 'en') => {
    const r = planOffline(request, { ...ctx(), language });
    if (!r.ok) throw new Error('no plan');
    return r.plan.steps[0]!;
  };

  it('takes the provider from the words, never an address', () => {
    expect(send('Email me via Gmail: the quarterly numbers are in').input).toEqual({
      to: [OWN],
      subject: 'the quarterly numbers are in',
      body: 'the quarterly numbers are in',
      via: 'google',
    });
    expect(send('Email me from my Outlook account: call Omar').input).toMatchObject({
      via: 'microsoft',
    });
    expect(send('Schick mir über Gmail: Zahlen sind da', 'de').input).toMatchObject({
      via: 'google',
    });
    expect(send('أرسل لي عبر Gmail: الأرقام جاهزة', 'ar').input).toMatchObject({ via: 'google' });
  });

  it('without a named account nothing is set (bind picks, SMTP first)', () => {
    expect(send('Email me: hello').input).not.toHaveProperty('via');
    expect(send('Email me a reminder: dentist').input).toMatchObject({ subject: 'dentist' });
  });
});
