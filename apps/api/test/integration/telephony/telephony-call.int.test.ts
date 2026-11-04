/**
 * The phone agent end to end (docs/architecture/phase-d.md §3.2, §9): real Postgres, the real
 * app with its signature-validated webhooks, the mock Twilio + call simulator, the worker.
 * "call +49 30 1234567 in German and ask if they have an appointment on Friday" → an approval
 * with the exact details → one call → the AI disclosure first → German turns → the times
 * collected → COMPLETED with evidence; and the flows around it (Arabic, English, transfer,
 * recording consent, voicemail, opt-out → do-not-call, injection, cross-tenant isolation).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalDetails, CallSession } from '@jarvis/contracts';
import { withContext } from '../../../src/db/pool';
import {
  approve,
  ask,
  CALLER_ID,
  clientOf,
  createTelephonyHarness,
  detail,
  newCaller,
  pendingApproval,
  type TelephonyHarness,
} from './harness';

let h: TelephonyHarness;
beforeAll(async () => {
  h = await createTelephonyHarness();
});
afterAll(() => h.close());

type PhoneCallDetails = Extract<ApprovalDetails, { kind: 'phone_call' }>;

describe('scenario: ask for an appointment on Friday, in German', () => {
  it('approval with the exact details → one call → disclosure first → times collected → COMPLETED', async () => {
    const number = '+49301234567';
    h.mock.setScenario(number, {
      turns: ['Ja, am Freitag hätten wir um 9:30 oder um 14 Uhr etwas frei.'],
    });
    const user = await newCaller(h);
    // The phone agent is a real capability on this server (Twilio configured, phone.call built).
    expect((await h.services.status.get(user)).capabilities.phoneCalls).toBe(true);
    expect(
      (await h.services.skills.list(user)).find((s) => s.id === 'phone-calling'),
    ).toMatchObject({
      status: 'implemented',
      available: true,
    });
    const taskId = await ask(
      h,
      user,
      'call +49 30 1234567 in German and ask if they have an appointment on Friday',
    );

    const waiting = await detail(h.db, user, taskId);
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    expect(h.mock.createRequests(number)).toHaveLength(0); // nothing is dialled before the approval
    const approval = await pendingApproval(h, user, taskId);
    expect(approval.toolId).toBe('phone.call');
    expect(approval.riskLevel).toBe('MEDIUM');
    expect(approval.reasons).toContain('PHONE_CALL');
    expect(approval.summaryMessage).toMatchObject({ key: 'approval.call', params: { number } });
    const d = approval.details as PhoneCallDetails;
    expect(d).toMatchObject({
      kind: 'phone_call',
      to: number,
      toDisplay: '+49 30 1234567',
      country: 'DE',
      onBehalfOf: 'Alex Example',
      callerId: CALLER_ID,
      callerIdDisplay: '+49 30 901820',
      language: 'de',
      purpose: 'availability',
      dialog: 'scripted',
      recording: 'off',
      voicemail: 'hang_up',
      transfer: { allowed: false, to: null },
      binding: false,
      maxDurationSeconds: 300,
      allowedHours: { start: '00:00', end: '23:59', timeZone: 'Europe/Berlin' },
      costEstimate: { amountMicro: 250_000, currency: 'USD' },
    });
    expect(d.script.opening).toMatch(
      /^Guten Tag, hier ist JARVIS, ein KI-Assistent, der im Auftrag von Alex Example anruft\./,
    );
    expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${d.date}T12:00:00Z`).getUTCDay()).toBe(5);

    await approve(h, user, taskId);

    // Placed exactly once, from this server's caller id, with status callbacks and AMD.
    const creates = h.mock.createRequests(number);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.form).toMatchObject({
      To: number,
      From: CALLER_ID,
      Method: 'POST',
      MachineDetection: 'Enable',
      AsyncAmd: 'true',
      Timeout: '30',
      TimeLimit: '330',
    });
    expect(creates[0]!.form.StatusCallbackEvent).toEqual([
      'initiated',
      'ringing',
      'answered',
      'completed',
    ]);
    const call = h.mock.callsTo(number)[0]!;
    // The first thing the callee hears: that an AI assistant calls, and for whom.
    expect(call.heard[0]!.text).toBe(d.script.opening);
    expect(call.heard[0]).toMatchObject({ language: 'de-DE', voice: 'Polly.Vicki-Neural' });
    expect(call.gathers[0]).toMatchObject({ input: 'speech', language: 'de-DE' });
    expect(call.heard.map((x) => x.text)).toContain(
      'Danke. Ich habe mir 9:30 Uhr und 14:00 Uhr am ' +
        call.heard[1]!.text.match(/am (.+?) einen/)?.[1] +
        ' notiert.',
    );
    // Every webhook the simulator sent was accepted.
    expect(
      h.mock.webhooks
        .filter((w) => w.callSid === call.sid)
        .every((w) => w.status === 200 || w.status === 204),
    ).toBe(true);

    const done = await detail(h.db, user, taskId);
    expect(done.status).toBe('COMPLETED');
    const step = done.steps[0]!;
    expect(step).toMatchObject({ toolId: 'phone.call', status: 'SUCCEEDED' });
    expect(step.output).toMatchObject({
      result: 'completed',
      goalReached: true,
      times: ['09:30', '14:00'],
    });
    expect(step.evidence.map((e) => e.code)).toEqual(
      expect.arrayContaining(['CALL_PLACED', 'AI_DISCLOSED', 'CALL_TRANSCRIPT', 'CALL_ENDED']),
    );
    expect(done.resultSummaryMessage ?? null).toMatchObject({ key: 'result.callCompleted' });
    const verified = done.events.find((e) => e.type === 'verification.passed');
    expect((verified!.data.checks as { key: string }[]).map((c) => c.key)).toEqual(
      expect.arrayContaining([
        'callConnected',
        'aiDisclosed',
        'callEnded',
        'goalReached',
        'consentRespected',
        'transcriptStored',
      ]),
    );
    // TaskDetail.calls: the attempt with its timeline, every turn and the structured outcome.
    const c = done.calls![0]! as CallSession;
    expect(c).toMatchObject({
      attempt: 1,
      to: number,
      status: 'ended',
      result: 'completed',
      providerCallSid: call.sid,
      failureReason: null,
      recording: { mode: 'off', consent: 'not_asked', artifactId: null },
    });
    expect(c.outcome).toMatchObject({
      goalReached: true,
      details: { times: ['09:30', '14:00'], date: d.date },
    });
    expect(c.turns[0]).toMatchObject({
      sequence: 0,
      speaker: 'agent',
      kind: 'disclosure',
      language: 'de',
    });
    expect(c.turns.some((t) => t.speaker === 'callee' && t.kind === 'answer')).toBe(true);
    expect(c.aiDisclosedAt).not.toBeNull();
    expect(c.timeline.map((e) => e.status)).toEqual(
      expect.arrayContaining(['queued', 'dialing', 'ringing', 'in_progress', 'ended']),
    );
    expect(c.durationSeconds).toBeGreaterThan(0);
    // The provider's price is recorded once, as a telephony cost of the task.
    expect(c.price).toMatchObject({ currency: 'USD' });
    const costs = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('cost_records')
        .selectAll()
        .where('task_id', '=', taskId)
        .where('category', '=', 'telephony')
        .execute(),
    );
    expect(costs).toHaveLength(1);

    // The user routes read the same call.
    const http = await clientOf(h, user);
    const list = await http('GET', '/v1/calls');
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).not.toHaveProperty('turns');
    const one = await http('GET', `/v1/calls/${c.id}`);
    expect(one.statusCode).toBe(200);
    expect(one.json().turns.length).toBe(c.turns.length);
  });
});
