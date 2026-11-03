/**
 * End-to-end agent runtime against real Postgres, a local website and an
 * SMTP sink: plan → policy → approval → execution → verification, plus the
 * duplicate-side-effect, mismatch, rejection, injection and retry paths.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueue } from '../../../src/modules/jobs/queue';
import { withContext } from '../../../src/db/pool';
import {
  auditActions,
  auditMetadata,
  connectSmtp,
  connectWeb,
  createHarness,
  detail,
  drain,
  executions,
  makeJobsDue,
  newUser,
  SENDER,
  type Harness,
} from './harness';

let h: Harness;
let crashNextEmail = false;

beforeAll(async () => {
  h = await createHarness({
    testHooks: {
      afterToolExecute: (toolId) => {
        if (toolId === 'email.send' && crashNextEmail) {
          crashNextEmail = false;
          throw new Error('simulated worker crash after the email was handed to the server');
        }
      },
    },
  });
});
afterAll(() => h.close());

async function connectedUser() {
  const user = await newUser(h.db);
  await connectWeb(h.db, user);
  await connectSmtp(h.db, h.secrets, user, h.smtp.port);
  return user;
}

async function submit(user: Awaited<ReturnType<typeof connectedUser>>, request: string) {
  const summary = await h.services.tasks.create(user, { request, source: 'text' }, {});
  await drain(h.worker);
  return detail(h.db, user, summary.id);
}

describe('vertical slice: summarize a page and email it', () => {
  it('plans 3 steps, asks for approval with exact email details, then completes with evidence', async () => {
    const user = await connectedUser();
    const request = `Summarize ${h.site.url('/article')} and email it to me`;
    const created = await h.services.tasks.create(user, { request, source: 'text' }, {});
    expect(created.status).toBe('QUEUED');
    expect(created.title).toBe(request.slice(0, 80));

    await drain(h.worker);
    const waiting = await detail(h.db, user, created.id);
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    expect(waiting.planner).toEqual({ mode: 'offline', provider: null, model: null });
    expect(waiting.title).toBe(`Summarize 127.0.0.1:${h.site.port} and email it to you`);
    expect(waiting.titleMessage).toEqual({
      key: 'plan.summarizeEmail',
      params: { host: `127.0.0.1:${h.site.port}` },
    });
    expect(waiting.steps.map((s) => s.titleMessage?.key)).toEqual([
      'step.fetch',
      'step.summarize',
      'step.emailSummary',
    ]);
    expect(waiting.pendingApproval).toEqual({
      id: waiting.pendingApprovalId,
      untrustedSource: false,
    });
    expect(waiting.steps.map((s) => [s.toolId, s.status])).toEqual([
      ['web.fetch', 'SUCCEEDED'],
      ['text.summarize', 'SUCCEEDED'],
      ['email.send', 'AWAITING_APPROVAL'],
    ]);
    expect(waiting.riskLevel).toBe('MEDIUM');
    expect(waiting.pendingApprovalId).not.toBeNull();
    expect(h.smtp.to(user.email)).toHaveLength(0);

    const approval = waiting.approvals.find((a) => a.status === 'PENDING')!;
    expect(approval.toolId).toBe('email.send');
    expect(approval.reasons).toEqual(['RISK_MEDIUM', 'RECIPIENT_SELF']);
    expect(approval.details).toMatchObject({
      kind: 'email',
      from: `JARVIS <${SENDER}>`,
      to: [user.email],
      subject: 'Summary: Renewables overtake coal in Europe',
    });
    if (approval.details.kind !== 'email') throw new Error('expected email details');
    expect(approval.details.body).toContain(
      'Renewable sources generated more electricity than coal',
    );
    expect(approval.details.body).toContain('Extractive summary');
    expect(approval.details.body).toContain(`Source: ${h.site.url('/article')}`);
    expect(approval.summary).toBe(
      `Send the email “Summary: Renewables overtake coal in Europe” to ${user.email}.`,
    );
    expect(approval.summaryMessage).toEqual({
      key: 'approval.email',
      params: { subject: 'Summary: Renewables overtake coal in Europe', recipients: user.email },
    });
    expect(approval.taskTitleMessage?.key).toBe('plan.summarizeEmail');
    expect(approval.details).not.toHaveProperty('untrusted');

    const decided = await h.services.approvals.decide(
      user,
      approval.id,
      { decision: 'approve', actionHash: approval.actionHash },
      'web',
    );
    expect(decided.status).toBe('APPROVED');
    await drain(h.worker);

    const done = await detail(h.db, user, created.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.steps.every((s) => s.status === 'SUCCEEDED')).toBe(true);
    expect(done.progress).toEqual({ completed: 3, total: 3 });
    expect(done.resultSummary).toBe(
      `Sent “Summary: Renewables overtake coal in Europe” to ${user.email}.`,
    );
    expect(done.resultSummaryMessage).toEqual({
      key: 'result.emailSent',
      params: { subject: 'Summary: Renewables overtake coal in Europe', recipients: user.email },
    });
    expect(done.completedAt).not.toBeNull();
    expect(done.cost).toEqual({ estimatedMicroUsd: 0, actualMicroUsd: 0 });

    const sent = h.smtp.to(user.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('Summary: Renewables overtake coal in Europe');
    expect(sent[0]!.from).toBe(SENDER);

    const kinds = done.evidence.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['http_response', 'content_hash', 'note', 'smtp_receipt']),
    );
    const receipt = done.evidence.find((e) => e.kind === 'smtp_receipt')!;
    expect(receipt.value).toMatch(/^250 /);
    expect(receipt.value).toContain(sent[0]!.messageId);
    expect(done.evidence.find((e) => e.kind === 'http_response')!.value).toContain(`→ 200`);
    // Every piece of evidence also carries its facts as a code + params.
    expect(done.evidence.map((e) => e.code)).toEqual([
      'HTTP_RESPONSE',
      'CONTENT_HASH',
      'EXTRACTIVE_SUMMARY',
      'SMTP_RECEIPT',
    ]);
    expect(receipt.params).toMatchObject({
      replyCode: '250',
      accepted: 1,
      total: 1,
      messageId: sent[0]!.messageId,
    });
    expect(done.evidence.find((e) => e.code === 'EXTRACTIVE_SUMMARY')!.params).toMatchObject({
      excludedSentences: 0,
    });
    // Verification results are data: a check key + params per line, the English line as fallback.
    const verified = done.events.find((e) => e.type === 'verification.passed')!;
    const checks = verified.data.checks as {
      stepId: string;
      step: string;
      key: string;
      params: Record<string, unknown>;
      text: string;
    }[];
    expect(checks.map((c) => c.key)).toEqual([
      'http',
      'textExtracted',
      'hashRecorded',
      'summaryLength',
      'extractive',
      'recipientsAccepted',
      'noneRejected',
      'serverResponse',
      'messageId',
    ]);
    expect(checks[5]).toMatchObject({
      stepId: done.steps[2]!.id,
      params: { accepted: 1, count: 1 },
      text: '1/1 recipients accepted',
    });

    const types = done.events.map((e) => e.type);
    for (const t of [
      'task.created',
      'plan.ready',
      'step.started',
      'step.succeeded',
      'approval.requested',
      'approval.decided',
      'verification.passed',
    ])
      expect(types).toContain(t);
    const statuses = done.events
      .filter((e) => e.type === 'task.status_changed')
      .map((e) => e.data.to);
    expect(statuses).toEqual([
      'PLANNING',
      'RUNNING',
      'AWAITING_APPROVAL',
      'RUNNING',
      'VERIFYING',
      'COMPLETED',
    ]);

    const execs = await executions(h.db, user, created.id);
    expect(execs.map((e) => [e.tool_id, e.status])).toEqual([
      ['web.fetch', 'succeeded'],
      ['text.summarize', 'succeeded'],
      ['email.send', 'succeeded'],
    ]);
    expect(execs[2]!.idempotency_key).toBe(waiting.steps[2]!.id);

    const actions = await auditActions(user.userId);
    expect(actions).toEqual(
      expect.arrayContaining([
        'task.created',
        'approval.requested',
        'approval.approved',
        'email.sent',
      ]),
    );
    const sentAudit = await auditMetadata(user.userId, 'email.sent');
    expect(sentAudit[0]).toMatchObject({ recipientCount: 1 });
    expect(JSON.stringify(sentAudit)).not.toContain('Renewable'); // never the body

    // Notifications: approval requested, then completed.
    const notes = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('notifications')
        .select(['kind'])
        .where('task_id', '=', created.id)
        .orderBy('created_at')
        .execute(),
    );
    expect(notes.map((n) => n.kind)).toEqual(['approval_requested', 'task_completed']);

    // Running the execute job again never sends a second email.
    await withContext(h.db, user, (trx) =>
      enqueue(trx, {
        kind: 'task.execute',
        tenantId: user.tenantId,
        userId: user.userId,
        taskId: created.id,
        dedupeKey: `exec:${created.id}`,
      }),
    );
    await drain(h.worker);
    expect(h.smtp.to(user.email)).toHaveLength(1);
    expect((await detail(h.db, user, created.id)).status).toBe('COMPLETED');
  });

  it('a crash after sending is reported as OUTCOME_UNKNOWN and never re-sent automatically', async () => {
    const user = await connectedUser();
    const waiting = await submit(user, `Summarize ${h.site.url('/article')} and email it to me`);
    const approval = waiting.approvals.find((a) => a.status === 'PENDING')!;
    await h.services.approvals.decide(
      user,
      approval.id,
      { decision: 'approve', actionHash: approval.actionHash },
      'ios',
    );

    crashNextEmail = true;
    await drain(h.worker); // email handed to the server, then the "worker dies"
    expect(h.smtp.to(user.email)).toHaveLength(1);
    const mid = await detail(h.db, user, waiting.id);
    expect(mid.status).toBe('RUNNING');
    expect((await executions(h.db, user, waiting.id))[2]!.status).toBe('started');

    await makeJobsDue(h.db, waiting.id); // the queue retries the job (backoff skipped)
    await drain(h.worker);
    const failed = await detail(h.db, user, waiting.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: false });
    expect(failed.steps[2]!.status).toBe('FAILED');
    expect(h.smtp.to(user.email)).toHaveLength(1);
    expect((await executions(h.db, user, waiting.id))[2]!.status).toBe('unknown');

    // Retrying requires acknowledging the unknown outcome.
    await expect(
      h.services.tasks.retry(user, waiting.id, { acknowledgeUnknownOutcome: false }),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    const retried = await h.services.tasks.retry(user, waiting.id, {
      acknowledgeUnknownOutcome: true,
    });
    expect(retried.status).toBe('QUEUED');
    await drain(h.worker);
    const done = await detail(h.db, user, waiting.id);
    expect(done.status).toBe('COMPLETED');
    // Exactly one deliberate resend, carrying the same Message-ID so clients can de-duplicate.
    const sent = h.smtp.to(user.email);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.messageId).toBe(sent[0]!.messageId);
    expect(done.events.some((e) => e.type === 'task.retried')).toBe(true);
  });

  it('rejects a decision with the wrong actionHash (APPROVAL_MISMATCH)', async () => {
    const user = await connectedUser();
    const waiting = await submit(user, `Summarize ${h.site.url('/article')} and email it to me`);
    const approval = waiting.approvals.find((a) => a.status === 'PENDING')!;
    await expect(
      h.services.approvals.decide(
        user,
        approval.id,
        { decision: 'approve', actionHash: 'f'.repeat(64) },
        'web',
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' });
    const after = await detail(h.db, user, waiting.id);
    expect(after.status).toBe('AWAITING_APPROVAL');
    expect(after.approvals[0]!.status).toBe('PENDING');
    await drain(h.worker);
    expect(h.smtp.to(user.email)).toHaveLength(0);
  });

  it('reject → CANCELLED with an explanation, nothing sent', async () => {
    const user = await connectedUser();
    const waiting = await submit(user, `Summarize ${h.site.url('/article')} and email it to me`);
    const approval = waiting.approvals.find((a) => a.status === 'PENDING')!;
    const decided = await h.services.approvals.decide(
      user,
      approval.id,
      { decision: 'reject', actionHash: approval.actionHash, note: 'not now' },
      'web',
    );
    expect(decided).toMatchObject({ status: 'REJECTED', decisionNote: 'not now' });
    await drain(h.worker);
    const done = await detail(h.db, user, waiting.id);
    expect(done.status).toBe('CANCELLED');
    expect(done.resultSummary).toMatch(
      /^You declined this action, so nothing was sent or changed: Send the email/,
    );
    expect(done.resultSummaryMessage).toMatchObject({
      key: 'result.declined',
      params: { action: { key: 'approval.email' } },
    });
    expect(done.steps[2]!.status).toBe('CANCELLED');
    expect(h.smtp.to(user.email)).toHaveLength(0);
    expect(await auditActions(user.userId)).toContain('approval.rejected');
  });

  it('a page with a prompt injection is flagged and cannot change recipients or the plan', async () => {
    const user = await connectedUser();
    const waiting = await submit(user, `Summarize ${h.site.url('/injection')} and email it to me`);
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    expect(waiting.steps).toHaveLength(3);
    const fetched = waiting.steps[0]!;
    expect(fetched.output).toMatchObject({ suspectedInjection: true });
    expect((fetched.output as { injectionSignals: string[] }).injectionSignals).toEqual(
      expect.arrayContaining(['ignore_previous_instructions', 'exfiltration_request']),
    );
    const approval = waiting.approvals.find((a) => a.status === 'PENDING')!;
    expect(approval.reasons).toContain('UNTRUSTED_CONTENT');
    if (approval.details.kind !== 'email') throw new Error('expected email details');
    expect(approval.details.to).toEqual([user.email]);
    expect(approval.details.body).not.toContain('attacker@evil.test');
    // The approval says what was flagged and what JARVIS did with it — never the text itself.
    const summarized = waiting.steps[1]!.output as { excludedSentences: number };
    expect(summarized.excludedSentences).toBeGreaterThan(0);
    expect(approval.details.untrusted).toEqual({
      host: `127.0.0.1:${h.site.port}`,
      excludedSentences: summarized.excludedSentences,
      signals: expect.arrayContaining(['ignore_previous_instructions', 'exfiltration_request']),
    });
    expect(JSON.stringify(approval.details.untrusted)).not.toContain('attacker@evil.test');
    expect(waiting.pendingApproval).toEqual({ id: approval.id, untrustedSource: true });

    await h.services.approvals.decide(
      user,
      approval.id,
      { decision: 'approve', actionHash: approval.actionHash },
      'web',
    );
    await drain(h.worker);
    const done = await detail(h.db, user, waiting.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.steps).toHaveLength(3);
    expect(h.smtp.to('attacker@evil.test')).toHaveLength(0);
    const sent = h.smtp.to(user.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual([user.email]);
  });

  it('retry after an SMTP outage completes and sends exactly once', async () => {
    const user = await connectedUser();
    const waiting = await submit(user, `Summarize ${h.site.url('/article')} and email it to me`);
    const approval = waiting.approvals.find((a) => a.status === 'PENDING')!;

    await h.smtp.stop();
    try {
      await h.services.approvals.decide(
        user,
        approval.id,
        { decision: 'approve', actionHash: approval.actionHash },
        'web',
      );
      await drain(h.worker);
      const failed = await detail(h.db, user, waiting.id);
      expect(failed.status).toBe('FAILED');
      expect(failed.error).toMatchObject({ code: 'CONNECTION_FAILED', retryable: true });
      expect((await executions(h.db, user, waiting.id))[2]!.status).toBe('failed');
    } finally {
      await h.smtp.start();
    }

    const before = h.smtp.to(user.email).length;
    await h.services.tasks.retry(user, waiting.id, { acknowledgeUnknownOutcome: false });
    await drain(h.worker);
    const done = await detail(h.db, user, waiting.id);
    expect(done.status).toBe('COMPLETED');
    expect(h.smtp.to(user.email).length - before).toBe(1);
    // The approved action was unchanged, so no second approval was needed.
    expect(done.approvals.map((a) => a.status)).toEqual(['APPROVED']);
    // The page was not fetched again: completed steps are kept on retry.
    const execs = await executions(h.db, user, waiting.id);
    expect(execs.filter((e) => e.tool_id === 'web.fetch')).toHaveLength(1);
    expect(execs.filter((e) => e.tool_id === 'email.send').map((e) => e.status)).toEqual([
      'succeeded',
    ]);
  });
});
