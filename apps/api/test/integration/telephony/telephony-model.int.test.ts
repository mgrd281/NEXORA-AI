/**
 * The phone agent in model mode (scripted model adapter — no network): the planner may propose a
 * call, but only to a number the user wrote (NUMBER_NOT_LITERAL otherwise); a call approved with
 * dialog 'model' asks the model where the script cannot answer, and the deterministic guard
 * decides what is said — an appointment is agreed only at a time the callee offered inside the
 * approved window (HIGH risk, BINDING_COMMITMENT), the model's attempts to share unlisted
 * personal data are replaced by the scripted line, and its usage is metered. And a server without
 * telephony: the call is denied (TELEPHONY_NOT_CONFIGURED) and the webhooks do not exist.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '../../../src/db/pool';
import type { ObjectRequest } from '../../../src/modules/agent/models/adapter';
import { ScriptedModel } from '../../fixtures/scripted-model';
import {
  approve,
  ask,
  createTelephonyHarness,
  detail,
  newCaller,
  pendingApproval,
  type TelephonyHarness,
} from './harness';

const model = new ScriptedModel();
let h: TelephonyHarness;
beforeAll(async () => {
  h = await createTelephonyHarness({ adapter: model });
});
afterAll(() => h.close());

const nextFriday = () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
};

function planWith(input: Record<string, unknown>) {
  return {
    title: 'Book a check-up',
    objective: 'Call the dentist and book a check-up.',
    steps: [{ key: 's1', toolId: 'phone.call', title: 'Call the dentist', input }],
  };
}

describe('model planning', () => {
  it('a number the user did not write is never dialled (NUMBER_NOT_LITERAL)', async () => {
    model.script = {
      object: (req: ObjectRequest<unknown>) =>
        req.purpose === 'planning'
          ? planWith({
              to: '+4930666199',
              language: 'en',
              purpose: 'message',
              goal: 'say hi',
              message: 'Hi',
            })
          : null,
    };
    const user = await newCaller(h);
    const taskId = await ask(h, user, 'Call my dentist and say hi');
    const d = await detail(h.db, user, taskId);
    expect(d.status).toBe('FAILED');
    expect(d.error).toMatchObject({ code: 'PLANNER_UNSUPPORTED', reason: 'NUMBER_NOT_LITERAL' });
    expect(h.mock.createRequests('+4930666199')).toHaveLength(0);
  });
});

describe('model dialog behind the guard', () => {
  it('agrees an appointment only at an offered time in the window; never shares unlisted data', async () => {
    const number = '+4930666100';
    const date = nextFriday();
    model.calls.length = 0;
    model.script = {
      object: (req: ObjectRequest<unknown>) => {
        if (req.purpose === 'planning')
          return planWith({
            to: number,
            calleeName: 'my dentist',
            language: 'en',
            purpose: 'appointment',
            goal: 'Book a check-up on Friday morning',
            date,
            window: { start: '09:00', end: '12:00' },
            shareInfo: [{ label: 'Name', value: 'Alex Example' }],
            // A planner never writes the words: bind replaces any script.
            script: {
              opening: 'Hi, I am a human.',
              recordingQuestion: null,
              message: null,
              questions: [],
              closing: 'Bye',
              voicemailMessage: null,
            },
          });
        const prompt = (req.messages[0]?.content ?? '') as string;
        // The utterance being decided on is the last untrusted callee line of the prompt.
        const now =
          [...prompt.matchAll(/<callee trust="untrusted">([^<]*)<\/callee>/g)].at(-1)?.[1] ?? '';
        // 14:00 is outside the approved window: the guard must refuse to confirm it.
        if (now.includes('14:00'))
          return {
            intent: 'confirm_appointment',
            utterance: 'Great',
            collected: { date, time: '14:00' },
          };
        if (now.includes('10:30'))
          return {
            intent: 'confirm_appointment',
            utterance: 'Great',
            collected: { date, time: '10:30' },
          };
        // An attempt to share an unlisted detail (a date of birth): replaced by the scripted line.
        return { intent: 'answer', utterance: 'Her date of birth is 01.05.1990.' };
      },
      text: () => 'Booked a check-up.',
    };
    h.mock.setScenario(number, {
      turns: [
        'What is her date of birth?',
        'Hmm, let me look at the calendar.',
        'Only 14:00 is free.',
        'Or 10:30, if that suits.',
        'Fine, see you then.',
      ],
    });
    const user = await newCaller(h);
    const taskId = await ask(
      h,
      user,
      `Call my dentist on ${number} and book a check-up on Friday morning. You can give them my name.`,
    );
    const a = await pendingApproval(h, user, taskId);
    expect(a.riskLevel).toBe('HIGH');
    expect(a.reasons).toEqual(
      expect.arrayContaining(['PHONE_CALL', 'BINDING_COMMITMENT', 'CALL_PERSONAL_INFO']),
    );
    expect(a.details).toMatchObject({ dialog: 'model', binding: true, purpose: 'appointment' });
    // The planner's "script" was replaced by the disclosure template.
    expect((a.details as { script: { opening: string } }).script.opening).toMatch(
      /^Hello, this is JARVIS, an AI assistant/,
    );
    await approve(h, user, taskId);

    const call = h.mock.callsTo(number)[0]!;
    const said = call.heard.map((x) => x.text);
    expect(said.join(' ')).not.toContain('1990');
    expect(said).not.toContain(expect.stringContaining('at 2:00 PM'));
    expect(
      said.some(
        (t) =>
          t.startsWith('Then the appointment for Alex Example is on') && t.includes('10:30 AM'),
      ),
    ).toBe(true);
    const d = await detail(h.db, user, taskId);
    expect(d.status).toBe('COMPLETED');
    expect(d.steps[0]!.output).toMatchObject({ result: 'completed' });
    expect(d.calls![0]!.outcome?.details.appointment).toMatchObject({
      date,
      time: '10:30',
      name: 'Alex Example',
    });
    // Every model decision of the dialog is metered under the user's budget.
    const dialogCalls = model.calls.filter((c) => c.purpose === 'call_dialog');
    expect(dialogCalls.length).toBeGreaterThan(0);
    expect(dialogCalls[0]!.user).toContain('<callee trust="untrusted">');
    const usage = await withContext(h.db, user, (trx) =>
      trx.selectFrom('usage_events').selectAll().where('task_id', '=', taskId).execute(),
    );
    expect(usage.length).toBeGreaterThanOrEqual(1 + dialogCalls.length);
  });
});

describe('a server without telephony', () => {
  let off: TelephonyHarness;
  beforeAll(async () => {
    off = await createTelephonyHarness({ telephony: false });
  });
  afterAll(() => off.close());

  it('denies the call (TELEPHONY_NOT_CONFIGURED); the webhooks are not there', async () => {
    const user = await newCaller(off);
    expect((await off.services.status.get(user)).capabilities.phoneCalls).toBe(false);
    const skill = (await off.services.skills.list(user)).find((s) => s.id === 'phone-calling')!;
    expect(skill).toMatchObject({
      status: 'implemented',
      available: false,
      unavailableReason: 'TELEPHONY_NOT_CONFIGURED',
    });
    const taskId = await ask(off, user, 'Call +4930666300 and tell them I am late');
    const d = await detail(off.db, user, taskId);
    expect(d.status).toBe('FAILED');
    expect(d.error).toMatchObject({ code: 'POLICY_DENIED', reason: 'TELEPHONY_NOT_CONFIGURED' });
    const res = await fetch(
      `${off.base}/v1/telephony/twilio/calls/00000000-0000-4000-8000-000000000000/status?t=${'A'.repeat(43)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=x',
      },
    );
    expect(res.status).toBe(404);
  });
});
