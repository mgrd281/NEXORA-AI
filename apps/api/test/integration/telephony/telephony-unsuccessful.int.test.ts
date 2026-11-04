/**
 * Scenario 4 — an unsuccessful phone call (docs/architecture/phase-d.md §3.2, §9), and
 * exactly-once dialling: busy / no answer / failed / voicemail / refused each end FAILED with
 * their precise reason and a safe retry (a NEW attempt, policy-checked again); a busy line, then
 * a retry that is answered → COMPLETED; a replayed job never dials twice; a provider whose
 * answer is unknown → OUTCOME_UNKNOWN (CALL_STATE_UNKNOWN), and the acknowledged retry
 * reconciles with the provider before anything is dialled again; the watchdog.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '../../../src/db/pool';
import { dial, planAttempt } from '../../../src/modules/telephony/attempts';
import type { ApprovedCall } from '../../../src/modules/telephony/dialog/state';
import { createTelephonyGateway } from '../../../src/modules/telephony/gateway';
import { asOwner, makeAllJobsDue, makeJobsDue } from '../agent/harness';
import {
  approve,
  ask,
  CALLER_ID,
  callsOf,
  createTelephonyHarness,
  detail,
  drain,
  newCaller,
  type TelephonyHarness,
} from './harness';

let h: TelephonyHarness;
let crashNextCall = false;
beforeAll(async () => {
  h = await createTelephonyHarness({
    testHooks: {
      afterToolExecute: (toolId) => {
        if (toolId === 'phone.call' && crashNextCall) {
          crashNextCall = false;
          throw new Error('simulated worker crash after the call ended');
        }
      },
    },
  });
});
afterAll(() => h.close());

const request = (n: string) => `Call ${n} and ask if they have an appointment free tomorrow`;

describe('scenario 4: busy, then a retry that is answered', () => {
  it('FAILED CALL_BUSY (retryable) → retry → attempt 2 answered → COMPLETED', async () => {
    const number = '+4940123456';
    h.mock.setScenario(number, { outcome: 'busy' });
    const user = await newCaller(h);
    const taskId = await ask(h, user, request('+49 40 123456'));
    await approve(h, user, taskId);

    const failed = await detail(h.db, user, taskId);
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toMatchObject({
      code: 'TOOL_FAILED',
      reason: 'CALL_BUSY',
      retryable: true,
    });
    expect(failed.canRetry).toBe(true);
    expect(failed.calls).toHaveLength(1);
    expect(failed.calls![0]).toMatchObject({
      result: 'busy',
      failureReason: 'CALL_BUSY',
      aiDisclosedAt: null,
    });
    expect(failed.calls![0]!.turns).toHaveLength(0); // nobody answered: nothing was said
    expect(h.mock.createRequests(number)).toHaveLength(1);

    // The line is free now. A retry places a new attempt (the approval still binds the action).
    h.mock.setScenario(number, { turns: ['Yes, tomorrow at 10:30 works.'] });
    await h.services.tasks.retry(user, taskId, { acknowledgeUnknownOutcome: false });
    await drain(h.worker);
    const done = await detail(h.db, user, taskId);
    expect(done.status).toBe('COMPLETED');
    expect(h.mock.createRequests(number)).toHaveLength(2);
    expect(done.calls!.map((c) => [c.attempt, c.result])).toEqual([
      [1, 'busy'],
      [2, 'completed'],
    ]);
    expect(done.steps[0]!.output).toMatchObject({ attempt: 2, times: ['10:30'] });
  });
});

describe('each unsuccessful result has its precise reason and a safe retry', () => {
  it.each([
    ['+4930555012', { outcome: 'no-answer' as const }, 'CALL_NO_ANSWER', 'no_answer'],
    ['+4930555013', { outcome: 'failed' as const, sipResponseCode: 503 }, 'CALL_FAILED', 'failed'],
    ['+4930555014', { outcome: 'machine' as const }, 'CALL_VOICEMAIL', 'voicemail'],
    ['+4930555015', { turns: [{ hangup: true as const }] }, 'CALL_HUNG_UP', 'hung_up'],
  ])('%s → %s', async (number, scenario, reason, result) => {
    h.mock.setScenario(number, scenario);
    const user = await newCaller(h);
    const taskId = await ask(h, user, request(number));
    await approve(h, user, taskId);
    const t = await detail(h.db, user, taskId);
    expect(t.status).toBe('FAILED');
    expect(t.error).toMatchObject({ code: 'TOOL_FAILED', reason, retryable: true });
    expect(t.canRetry).toBe(true);
    expect(t.calls![0]).toMatchObject({ result, failureReason: reason, status: 'ended' });
    expect(h.mock.createRequests(number)).toHaveLength(1);
    if (reason === 'CALL_VOICEMAIL') {
      // The default is to hang up on a machine: no message was left.
      const call = h.mock.callsTo(number)[0]!;
      expect(call.updates.some((u) => String(u.Twiml ?? '').includes('<Hangup/>'))).toBe(true);
      expect(t.calls![0]!.answeredBy).toBe('machine');
      expect(t.calls![0]!.outcome?.notes).not.toContain('VOICEMAIL_MESSAGE_LEFT');
    }
    if (reason === 'CALL_FAILED') expect(t.error!.params).toMatchObject({ status: 'failed' });
  });

  it('the provider refuses the create request → PROVIDER_REJECTED; nothing was placed', async () => {
    const number = '+4930555016';
    h.mock.setScenario(number, { outcome: 'reject', rejectCode: 21215 });
    const user = await newCaller(h);
    const taskId = await ask(h, user, request(number));
    await approve(h, user, taskId);
    const t = await detail(h.db, user, taskId);
    expect(t.error).toMatchObject({
      reason: 'PROVIDER_REJECTED',
      retryable: true,
      params: { provider: 'twilio', status: 400 },
    });
    expect(t.calls![0]).toMatchObject({ result: 'failed', providerCallSid: null });
    expect(h.mock.callsTo(number)).toHaveLength(0);
  });

  it('leaves the approved voicemail message when asked to', async () => {
    const number = '+4930555017';
    h.mock.setScenario(number, { outcome: 'machine' });
    const user = await newCaller(h);
    const taskId = await ask(
      h,
      user,
      `Call ${number} and tell them I will be 10 minutes late. Leave a message if nobody answers.`,
    );
    await approve(h, user, taskId);
    const t = await detail(h.db, user, taskId);
    expect(t.error).toMatchObject({ reason: 'CALL_VOICEMAIL' });
    const call = h.mock.callsTo(number)[0]!;
    expect(
      call.heard.some(
        (x) =>
          /I will be 10 minutes late/.test(x.text) &&
          /^Hello, this is JARVIS, an AI assistant/.test(x.text),
      ),
    ).toBe(true);
    expect(t.calls![0]!.outcome?.notes).toContain('VOICEMAIL_MESSAGE_LEFT');
  });
});

describe('exactly once', () => {
  it('the worker dies after the call: the replayed job is OUTCOME_UNKNOWN, the acknowledged retry reuses the call', async () => {
    const number = '+4930555018';
    h.mock.setScenario(number, { turns: ['Yes, at 9:30.'] });
    const user = await newCaller(h);
    const taskId = await ask(h, user, request(number));
    crashNextCall = true;
    await approve(h, user, taskId); // the call ended, then the "worker dies" before recording it
    expect(h.mock.createRequests(number)).toHaveLength(1);
    expect((await detail(h.db, user, taskId)).status).toBe('RUNNING');
    await makeJobsDue(h.db, taskId); // the queue redelivers the job
    await drain(h.worker);
    const unknown = await detail(h.db, user, taskId);
    expect(unknown.error).toMatchObject({ code: 'OUTCOME_UNKNOWN', reason: 'STEP_INTERRUPTED' });
    await h.services.tasks.retry(user, taskId, { acknowledgeUnknownOutcome: true });
    await drain(h.worker);
    const done = await detail(h.db, user, taskId);
    expect(done.status).toBe('COMPLETED');
    // The finished call's outcome was adopted: never a second call for the same attempt.
    expect(h.mock.createRequests(number)).toHaveLength(1);
    expect(await callsOf(h, user, taskId)).toHaveLength(1);
    expect(done.steps[0]!.output).toMatchObject({ attempt: 1, times: ['09:30'] });
  });

  it('a lost answer to the create request → OUTCOME_UNKNOWN; the acknowledged retry adopts the call', async () => {
    const number = '+4930555019';
    // The call is placed, but the create request answers 500 without a body.
    h.mock.setScenario(number, { outcome: 'error500', turns: ['Ja, um 11 Uhr.'] });
    const user = await newCaller(h);
    const taskId = await ask(
      h,
      user,
      `Ruf ${number} an und frag, ob sie morgen einen Termin frei haben`,
    );
    await approve(h, user, taskId);
    const unknown = await detail(h.db, user, taskId);
    expect(unknown.status).toBe('FAILED');
    expect(unknown.error).toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      reason: 'CALL_STATE_UNKNOWN',
      retryable: false,
    });
    // A retry needs the user to acknowledge it.
    await expect(
      h.services.tasks.retry(user, taskId, { acknowledgeUnknownOutcome: false }),
    ).rejects.toThrow();
    // Meanwhile the call happened (its webhooks name the attempt): wait for it to end.
    const call = await h.mock.waitFor(() => h.mock.callsTo(number)[0]);
    await h.mock.waitForEnded(call.sid);
    await h.mock.waitFor(() =>
      h.mock.webhooks.some(
        (w) => w.callSid === call.sid && w.kind === 'status:completed' && w.status === 204,
      ),
    );
    await h.services.tasks.retry(user, taskId, { acknowledgeUnknownOutcome: true });
    await drain(h.worker);
    const done = await detail(h.db, user, taskId);
    expect(done.status).toBe('COMPLETED');
    expect(h.mock.createRequests(number)).toHaveLength(1); // never a second call
    expect(done.calls).toHaveLength(1);
    expect(done.calls![0]).toMatchObject({ providerCallSid: call.sid, result: 'completed' });
  });

  it('unknown, and the provider lists no such call → the acknowledged retry dials attempt 2', async () => {
    const number = '+4930555020';
    h.mock.setScenario(number, { turns: ['Yes, at 15:00.'] });
    // The first create request fails with a 5xx before anything was created.
    h.mock.failNextCreate({ status: 503, code: 20503, message: 'Service unavailable' });
    const user = await newCaller(h);
    const taskId = await ask(h, user, request(number));
    await approve(h, user, taskId);
    expect((await detail(h.db, user, taskId)).error).toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      reason: 'CALL_STATE_UNKNOWN',
    });
    // Right away, an empty provider call list proves nothing (it may lag): still unknown.
    await h.services.tasks.retry(user, taskId, { acknowledgeUnknownOutcome: true });
    await drain(h.worker);
    expect((await detail(h.db, user, taskId)).error).toMatchObject({
      reason: 'CALL_STATE_UNKNOWN',
    });
    expect(h.mock.callsTo(number)).toHaveLength(0);
    // A minute later the provider still lists no such call: nothing was placed.
    await asOwner(
      `UPDATE call_sessions SET created_at = now() - interval '2 minutes' WHERE task_id = $1`,
      [taskId],
    );
    await h.services.tasks.retry(user, taskId, { acknowledgeUnknownOutcome: true });
    await drain(h.worker);
    const done = await detail(h.db, user, taskId);
    expect(done.status).toBe('COMPLETED');
    expect(done.calls!.map((c) => [c.attempt, c.result, c.failureReason])).toEqual([
      [1, 'failed', 'CALL_FAILED'],
      [2, 'completed', null],
    ]);
    // The reconciliation asked the provider's call list before dialling again.
    expect(
      h.mock.requests.some(
        (r) => r.method === 'GET' && r.path.endsWith('/Calls.json') && r.query.To === number,
      ),
    ).toBe(true);
    expect(h.mock.callsTo(number)).toHaveLength(1);
  });

  it('the watchdog: a call whose callbacks never arrived is ended and settled from the provider', async () => {
    const number = '+4930555021';
    h.mock.setScenario(number, { turns: ['Hello?'] });
    const user = await newCaller(h);
    const taskId = await ask(h, user, request(number));
    const step = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('task_steps')
        .selectAll()
        .where('task_id', '=', taskId)
        .executeTakeFirstOrThrow(),
    );
    // Place the attempt as the tool does, but with webhooks pointing nowhere (all missed).
    const lost = {
      ...h.config,
      telephony: { ...h.config.telephony!, webhookBase: 'http://127.0.0.1:9' },
    };
    const gw = createTelephonyGateway(lost)!;
    const input = step.input as unknown as ApprovedCall;
    const plan = await planAttempt(
      h.db,
      user,
      h.config,
      {
        taskId,
        stepId: step.id,
        input,
        callerId: CALLER_ID,
        maxDurationSeconds: 60,
        costEstimateMicro: null,
        approvalId: null,
        actionHash: 'x'.repeat(64),
      },
      'Europe/Berlin',
    );
    expect(plan.kind).toBe('dial');
    const placed = await dial(h.db, user, gw, plan as Extract<typeof plan, { kind: 'dial' }>);
    expect(placed.status).toBe('dialing');
    await h.mock.waitForEnded(placed.provider_call_sid!);
    // The watchdog job is due now.
    await makeAllJobsDue(h.db);
    await drain(h.worker);
    const [row] = await callsOf(h, user, taskId);
    expect(row).toMatchObject({ status: 'ended', provider_call_sid: placed.provider_call_sid });
    expect(row!.price_micro).not.toBeNull();
    expect(
      h.mock.requests.some(
        (r) => r.method === 'GET' && r.path.endsWith(`/Calls/${placed.provider_call_sid}.json`),
      ),
    ).toBe(true);
    expect(h.mock.createRequests(number)).toHaveLength(1);
  });
});
