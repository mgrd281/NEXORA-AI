/**
 * Agent runtime lifecycle and safety paths: expiry, SSRF blocking, missing
 * connections, offline limits, cancellation, tenant isolation, memory,
 * idempotent creation, auto-approval and assistant status.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '../../../src/db/pool';
import { startFixtureSite, type FixtureSite } from '../../fixtures/http-site';
import {
  connectSmtp,
  connectWeb,
  createHarness,
  detail,
  drain,
  executions,
  newUser,
  type Harness,
} from './harness';

let h: Harness;
let unlisted: FixtureSite;

beforeAll(async () => {
  h = await createHarness();
  unlisted = await startFixtureSite(); // a second local site that is NOT allow-listed
});
afterAll(async () => {
  await unlisted.close();
  await h.close();
});

async function connectedUser(prefs?: Parameters<typeof newUser>[1]) {
  const user = await newUser(h.db, prefs);
  await connectWeb(h.db, user);
  await connectSmtp(h.db, h.secrets, user, h.smtp.port);
  return user;
}

async function submit(user: Awaited<ReturnType<typeof newUser>>, request: string, key?: string) {
  const s = await h.services.tasks.create(
    user,
    { request, source: 'text' },
    { idempotencyKey: key },
  );
  await drain(h.worker);
  return detail(h.db, user, s.id);
}

describe('approval expiry', () => {
  it('the approval.expire job expires a pending approval and its task', async () => {
    const user = await connectedUser();
    const waiting = await submit(user, `Summarize ${h.site.url('/article')} and email it to me`);
    const approval = waiting.approvals[0]!;
    // Time travel: the approval expired and its job is due.
    await withContext(h.db, user, (trx) =>
      trx
        .updateTable('approvals')
        .set({ expires_at: new Date(Date.now() - 1_000) })
        .where('id', '=', approval.id)
        .execute(),
    );
    const jobs = await h.db
      .updateTable('jobs')
      .set({ run_at: new Date(0) })
      .where('kind', '=', 'approval.expire')
      .where('task_id', '=', waiting.id)
      .returning(['dedupe_key'])
      .execute();
    expect(jobs.map((j) => j.dedupe_key)).toEqual([`expire:${approval.id}`]);
    await drain(h.worker);

    const done = await detail(h.db, user, waiting.id);
    expect(done.status).toBe('EXPIRED');
    expect(done.error).toMatchObject({ code: 'APPROVAL_EXPIRED', retryable: true });
    expect(done.approvals[0]!.status).toBe('EXPIRED');
    expect(done.steps[2]!.status).toBe('CANCELLED');
    expect(done.events.find((e) => e.type === 'approval.decided')?.data).toMatchObject({
      decision: 'expired',
    });
    expect(h.smtp.to(user.email)).toHaveLength(0);
    const notes = await withContext(h.db, user, (trx) =>
      trx.selectFrom('notifications').select('kind').where('task_id', '=', waiting.id).execute(),
    );
    expect(notes.map((n) => n.kind)).toContain('task_failed');
  });

  it('deciding an expired approval marks it EXPIRED and returns APPROVAL_EXPIRED; retry asks again', async () => {
    const user = await connectedUser();
    const waiting = await submit(user, `Summarize ${h.site.url('/article')} and email it to me`);
    const approval = waiting.approvals[0]!;
    await withContext(h.db, user, (trx) =>
      trx
        .updateTable('approvals')
        .set({ expires_at: new Date(Date.now() - 1_000) })
        .where('id', '=', approval.id)
        .execute(),
    );
    await expect(
      h.services.approvals.decide(
        user,
        approval.id,
        { decision: 'approve', actionHash: approval.actionHash },
        'web',
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    const expired = await detail(h.db, user, waiting.id);
    expect(expired.status).toBe('EXPIRED');
    expect(expired.approvals[0]!.status).toBe('EXPIRED');

    await h.services.tasks.retry(user, waiting.id, { acknowledgeUnknownOutcome: false });
    await drain(h.worker);
    const again = await detail(h.db, user, waiting.id);
    expect(again.status).toBe('AWAITING_APPROVAL');
    expect(again.approvals.map((a) => a.status)).toEqual(['EXPIRED', 'PENDING']);
  });
});

describe('safety and policy', () => {
  it('a private address that is not allow-listed is blocked (FETCH_BLOCKED)', async () => {
    const user = await connectedUser();
    for (const url of [
      unlisted.url('/article'),
      `http://localhost:${unlisted.port}/article`,
      'http://169.254.169.254/latest/meta-data',
    ]) {
      const done = await submit(user, `Summarize ${url}`);
      expect(done.status).toBe('FAILED');
      expect(done.error).toMatchObject({
        code: 'FETCH_BLOCKED',
        retryable: false,
        reason: 'PRIVATE_ADDRESS',
      });
      expect(done.error?.params?.host).toBeTruthy();
      // A final task has nothing pending: the step that never ran reads as skipped.
      expect(done.steps.map((s) => s.status)).toEqual(['FAILED', 'SKIPPED']);
      expect(done.progress).toEqual({ completed: 0, total: 2 });
      // Retrying would be blocked the same way, so it is neither offered nor accepted.
      expect(done.canRetry).toBe(false);
      await expect(
        h.services.tasks.retry(user, done.id, { acknowledgeUnknownOutcome: false }),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    }
    expect(unlisted.hits).toHaveLength(0); // never connected
  });

  it('a redirect to a blocked address is blocked too', async () => {
    const site = await startFixtureSite({
      '/hop': { status: 302, headers: { location: unlisted.url('/article') } },
    });
    const local = await createHarness({
      env: { FETCH_ALLOW_PRIVATE_HOSTS: `127.0.0.1:${site.port}` },
    });
    try {
      const user = await newUser(local.db);
      await connectWeb(local.db, user);
      const s = await local.services.tasks.create(
        user,
        { request: `Summarize ${site.url('/hop')}`, source: 'text' },
        {},
      );
      await drain(local.worker);
      const done = await detail(local.db, user, s.id);
      expect(done.error?.code).toBe('FETCH_BLOCKED');
      expect(unlisted.hits).toHaveLength(0);
    } finally {
      await local.close();
      await site.close();
    }
  });

  it('missing smtp connection → FAILED with CONNECTION_REQUIRED before anything runs', async () => {
    const user = await newUser(h.db);
    await connectWeb(h.db, user);
    const done = await submit(user, `Summarize ${h.site.url('/article')} and email it to me`);
    expect(done.status).toBe('FAILED');
    expect(done.error).toMatchObject({
      code: 'CONNECTION_REQUIRED',
      retryable: true,
      reason: 'CONNECTION_MISSING',
    });
    expect(done.canRetry).toBe(true);
    expect(done.steps.map((s) => s.status)).toEqual(['SKIPPED', 'SKIPPED', 'BLOCKED']);
    expect(done.steps[2]!.policy).toEqual({ decision: 'deny', reasons: ['CONNECTION_MISSING'] });
    expect(done.events.some((e) => e.type === 'step.blocked')).toBe(true);
    expect(await executions(h.db, user, done.id)).toHaveLength(0);

    // Connecting SMTP and retrying resumes the same plan.
    await connectSmtp(h.db, h.secrets, user, h.smtp.port);
    await h.services.tasks.retry(user, done.id, { acknowledgeUnknownOutcome: false });
    await drain(h.worker);
    expect((await detail(h.db, user, done.id)).status).toBe('AWAITING_APPROVAL');
  });

  it('offline: an unsupported request fails with PLANNER_UNSUPPORTED', async () => {
    const user = await connectedUser();
    const done = await submit(user, 'What is the weather in Paris tomorrow?');
    expect(done.status).toBe('FAILED');
    expect(done.error).toMatchObject({
      code: 'PLANNER_UNSUPPORTED',
      reason: 'OFFLINE_UNSUPPORTED',
    });
    expect(done.steps).toHaveLength(0);
    expect(done.planner).toEqual({ mode: 'offline', provider: null, model: null });
    // Without an AI model a retry can only fail again.
    expect(done.canRetry).toBe(false);
    await expect(
      h.services.tasks.retry(user, done.id, { acknowledgeUnknownOutcome: false }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('email to self runs without approval when auto-approve is on', async () => {
    const user = await connectedUser({ autonomy: { autoApproveEmailToSelf: true } });
    const done = await submit(user, 'email me: pick up the dry cleaning');
    expect(done.status).toBe('COMPLETED');
    expect(done.approvals).toHaveLength(0);
    expect(done.steps[0]!.policy.reasons).toContain('AUTO_APPROVED_SELF');
    const sent = h.smtp.to(user.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.raw).toContain('pick up the dry cleaning');
  });

  it('unsupported content types are refused', async () => {
    const user = await connectedUser();
    const done = await submit(user, `Summarize ${h.site.url('/binary')}`);
    expect(done.error).toMatchObject({
      code: 'TOOL_FAILED',
      reason: 'UNSUPPORTED_CONTENT_TYPE',
      params: { contentType: 'application/octet-stream' },
    });
    expect(done.error?.message).toContain('application/octet-stream');
  });

  it('follows redirects on allowed hosts and reads plain text', async () => {
    const user = await connectedUser();
    const viaRedirect = await submit(user, `Summarize ${h.site.url('/redirect')}`);
    expect(viaRedirect.status).toBe('COMPLETED');
    expect(viaRedirect.steps[0]!.output).toMatchObject({
      finalUrl: h.site.url('/article'),
      status: 200,
    });
    const text = await submit(user, `read ${h.site.url('/notes.txt')}`);
    expect(text.status).toBe('COMPLETED');
    expect(text.resultSummary).toContain('The meeting moved to Thursday');
  });
});

describe('cancellation and isolation', () => {
  it('cancel while awaiting approval → CANCELLED, approval cancelled, nothing sent', async () => {
    const user = await connectedUser();
    const waiting = await submit(user, `Summarize ${h.site.url('/article')} and email it to me`);
    const approval = waiting.approvals[0]!;
    const cancelled = await h.services.tasks.cancel(user, waiting.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.pendingApprovalId).toBeNull();
    const d = await detail(h.db, user, waiting.id);
    expect(d.approvals[0]!.status).toBe('CANCELLED');
    expect(d.steps[2]!.status).toBe('CANCELLED');
    expect(d.resultSummary).toBe('Cancelled at your request.');
    expect(d.resultSummaryMessage).toEqual({ key: 'result.cancelled', params: {} });
    await expect(
      h.services.approvals.decide(
        user,
        approval.id,
        { decision: 'approve', actionHash: approval.actionHash },
        'web',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(h.services.tasks.cancel(user, waiting.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await drain(h.worker);
    expect(h.smtp.to(user.email)).toHaveLength(0);
  });

  it('cancel while queued is immediate; cancel while running stops at the next checkpoint', async () => {
    const user = await connectedUser();
    const queued = await h.services.tasks.create(
      user,
      { request: `Summarize ${h.site.url('/article')}`, source: 'text' },
      {},
    );
    expect((await h.services.tasks.cancel(user, queued.id)).status).toBe('CANCELLED');
    await drain(h.worker);
    expect((await detail(h.db, user, queued.id)).steps).toHaveLength(0); // never planned

    const running = await h.services.tasks.create(
      user,
      { request: `Summarize ${h.site.url('/article')}`, source: 'text' },
      {},
    );
    // Plan only (one job), leaving the task RUNNING with its execute job queued.
    const { runOnce } = await import('../../../src/worker');
    await runOnce(h.worker, { limit: 1 });
    expect((await detail(h.db, user, running.id)).status).toBe('RUNNING');
    const requested = await h.services.tasks.cancel(user, running.id);
    expect(requested.status).toBe('RUNNING');
    await drain(h.worker);
    const d = await detail(h.db, user, running.id);
    expect(d.status).toBe('CANCELLED');
    expect(d.events.some((e) => e.type === 'task.cancel_requested')).toBe(true);
    expect(d.steps.map((s) => s.status)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(await executions(h.db, user, running.id)).toHaveLength(0);
  });

  it('another tenant cannot see or decide your approval (NOT_FOUND)', async () => {
    const alice = await connectedUser();
    const mallory = await connectedUser();
    const waiting = await submit(alice, `Summarize ${h.site.url('/article')} and email it to me`);
    const approval = waiting.approvals[0]!;
    await expect(
      h.services.approvals.decide(
        mallory,
        approval.id,
        { decision: 'approve', actionHash: approval.actionHash },
        'web',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.services.tasks.cancel(mallory, waiting.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      h.services.tasks.retry(mallory, waiting.id, { acknowledgeUnknownOutcome: true }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await detail(h.db, alice, waiting.id)).approvals[0]!.status).toBe('PENDING');
  });

  it('a retry is only allowed for failed or expired tasks', async () => {
    const user = await connectedUser();
    const waiting = await submit(user, `Summarize ${h.site.url('/article')} and email it to me`);
    await expect(
      h.services.tasks.retry(user, waiting.id, { acknowledgeUnknownOutcome: false }),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
});

describe('crash recovery', () => {
  it('a plan job reclaimed after its worker died mid-planning resumes the task', async () => {
    const user = await connectedUser();
    const s = await h.services.tasks.create(
      user,
      { request: 'remember that recovery works', source: 'text' },
      {},
    );
    // State left behind by a worker that died after phase 1 (task already PLANNING).
    await withContext(h.db, user, (trx) =>
      trx
        .updateTable('tasks')
        .set({ status: 'PLANNING', started_at: new Date() })
        .where('id', '=', s.id)
        .execute(),
    );
    await drain(h.worker);
    const d = await detail(h.db, user, s.id);
    expect(d.status).toBe('COMPLETED');
    expect(d.steps.map((x) => x.status)).toEqual(['SUCCEEDED']);
  });

  it('an execute job reclaimed while the task was VERIFYING completes it', async () => {
    const user = await connectedUser();
    const done = await submit(user, 'remember that verification resumes');
    expect(done.status).toBe('COMPLETED');
    // State left behind by a worker that died between verification and completion.
    await withContext(h.db, user, async (trx) => {
      await trx
        .updateTable('tasks')
        .set({ status: 'VERIFYING', completed_at: null, result_summary: null })
        .where('id', '=', done.id)
        .execute();
      const { enqueue } = await import('../../../src/modules/jobs/queue');
      await enqueue(trx, {
        kind: 'task.execute',
        tenantId: user.tenantId,
        userId: user.userId,
        taskId: done.id,
        dedupeKey: `exec:${done.id}`,
      });
    });
    await drain(h.worker);
    const again = await detail(h.db, user, done.id);
    expect(again.status).toBe('COMPLETED');
    expect(again.resultSummary).toBe('Saved to memory: “Verification resumes”.');
    const rows = await withContext(h.db, user, (trx) =>
      trx.selectFrom('memories').select('id').execute(),
    );
    expect(rows).toHaveLength(1); // the step was not executed again
  });
});

describe('memory', () => {
  it("'remember that I prefer aisle seats' saves an assistant memory", async () => {
    const user = await connectedUser();
    const done = await submit(user, 'remember that I prefer aisle seats');
    expect(done.status).toBe('COMPLETED');
    expect(done.title).toBe('Remember: I prefer aisle seats');
    expect(done.titleMessage).toEqual({
      key: 'plan.remember',
      params: { text: 'I prefer aisle seats' },
    });
    expect(done.resultSummary).toBe('Saved to memory: “I prefer aisle seats”.');
    expect(done.resultSummaryMessage).toEqual({
      key: 'result.memorySaved',
      params: { text: 'I prefer aisle seats' },
    });
    expect(done.evidence.map((e) => [e.kind, e.code])).toEqual([['record', 'MEMORY_RECORD']]);
    const rows = await withContext(h.db, user, (trx) =>
      trx.selectFrom('memories').selectAll().execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      content: 'I prefer aisle seats.',
      kind: 'preference',
      source: 'assistant',
      source_task_id: done.id,
    });
  });

  it('memory.save is denied when memory is disabled', async () => {
    const user = await connectedUser({ memory: { enabled: false } });
    const done = await submit(user, 'remember that my locker code is 1234');
    expect(done.status).toBe('FAILED');
    expect(done.error?.code).toBe('POLICY_DENIED');
    expect(done.steps[0]!.policy.reasons).toEqual(['MEMORY_DISABLED']);
    const rows = await withContext(h.db, user, (trx) =>
      trx.selectFrom('memories').selectAll().execute(),
    );
    expect(rows).toHaveLength(0);
  });

  it('German and Arabic requests are planned in their language', async () => {
    const user = await connectedUser();
    const de = await submit(user, 'Merk dir, dass ich Gangplätze bevorzuge');
    expect(de).toMatchObject({ status: 'COMPLETED', title: 'Merken: Ich Gangplätze bevorzuge' });
    // The server sentence is data too, so an English UI can show it in English.
    expect(de.steps[0]!.titleMessage).toEqual({ key: 'step.remember', params: {} });
    expect(de.resultSummaryMessage).toEqual({
      key: 'result.memorySaved',
      params: { text: 'Ich Gangplätze bevorzuge' },
    });
    const ar = await submit(user, 'تذكر أن رقم غرفتي 214');
    expect(ar).toMatchObject({ status: 'COMPLETED', title: 'تذكّر: رقم غرفتي 214' });
  });
});

describe('task creation and status', () => {
  it('create is atomic and idempotent per key', async () => {
    const user = await connectedUser();
    const a = await h.services.tasks.create(
      user,
      { request: 'remember that tea > coffee', source: 'voice' },
      { idempotencyKey: 'key-12345678' },
    );
    const b = await h.services.tasks.create(
      user,
      { request: 'remember that tea > coffee', source: 'voice' },
      { idempotencyKey: 'key-12345678' },
    );
    expect(b.id).toBe(a.id);
    expect(a.source).toBe('voice');
    const counts = await withContext(h.db, user, async (trx) => ({
      tasks: (await trx.selectFrom('tasks').select('id').execute()).length,
      conversations: (await trx.selectFrom('conversations').select('id').execute()).length,
      messages: await trx.selectFrom('messages').select(['role', 'content']).execute(),
    }));
    expect(counts.tasks).toBe(1);
    expect(counts.conversations).toBe(1);
    expect(counts.messages).toEqual([{ role: 'user', content: 'remember that tea > coffee' }]);
    const jobs = await h.db
      .selectFrom('jobs')
      .select(['kind', 'dedupe_key'])
      .where('task_id', '=', a.id)
      .execute();
    expect(jobs).toEqual([{ kind: 'task.plan', dedupe_key: `plan:${a.id}` }]);
    await drain(h.worker);
  });

  it('status reflects the real planner route, worker heartbeat and connections', async () => {
    const user = await newUser(h.db, { memory: { enabled: false } });
    await connectWeb(h.db, user);
    const s = await h.services.status.get(user);
    expect(s.planner).toEqual({ mode: 'offline', provider: null, reason: 'NO_API_KEY' });
    expect(s.capabilities).toEqual({
      webFetch: true,
      email: false,
      memory: false,
      generalQuestions: false,
    });
    expect(s.version).toBe(h.config.APP_VERSION);
    expect(typeof s.worker.healthy).toBe('boolean');

    const withKey = await createHarness({ env: { ANTHROPIC_API_KEY: 'sk-test-not-used' } });
    try {
      expect((await withKey.services.status.get(user)).planner).toEqual({
        mode: 'model',
        provider: 'anthropic',
        reason: null,
      });
      const optedOut = await newUser(withKey.db, { ai: { allowExternalModels: false } });
      expect((await withKey.services.status.get(optedOut)).planner.reason).toBe(
        'USER_DISABLED_EXTERNAL_MODELS',
      );
      const broke = await newUser(withKey.db, { spending: { monthlyAiBudgetUsd: 0 } });
      expect((await withKey.services.status.get(broke)).planner.reason).toBe('BUDGET_EXHAUSTED');
    } finally {
      await withKey.close();
    }
  });
});
