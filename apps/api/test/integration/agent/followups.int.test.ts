/**
 * Conversation follow-ups end to end (offline planner, real Postgres, local
 * site, SMTP sink): "email it to me" after a summary in en/de/ar, the
 * conversation context and its limits, CONVERSATION_BUSY, idempotency,
 * exactly one JARVIS message per task, conversation titles, and the
 * untrusted-content rules for earlier results (taint → UNTRUSTED_CONTENT
 * approval; "remember that" → approval of the exact text, or refused).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '../../../src/db/pool';
import { AppError } from '../../../src/lib/errors';
import { loadConversationContext } from '../../../src/modules/agent/conversation-context';
import { ScriptedModel } from '../../fixtures/scripted-model';
import { textBody } from '../../fixtures/smtp-sink';
import {
  auditMetadata,
  connectSmtp,
  connectWeb,
  createHarness,
  detail,
  drain,
  newUser,
  type Harness,
} from './harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

async function connectedUser(locale: 'en' | 'de' | 'ar' = 'en', autoSelf = false) {
  const user = await newUser(h.db, { autonomy: { autoApproveEmailToSelf: autoSelf } });
  await withContext(h.db, user, (trx) =>
    trx.updateTable('users').set({ locale }).where('id', '=', user.userId).execute(),
  );
  await connectWeb(h.db, user);
  await connectSmtp(h.db, h.secrets, user, h.smtp.port);
  return user;
}

async function messages(user: { tenantId: string; userId: string }, conversationId: string) {
  return withContext(h.db, user, (trx) =>
    trx
      .selectFrom('messages')
      .select(['role', 'kind', 'content', 'content_message', 'task_id', 'language'])
      .where('conversation_id', '=', conversationId)
      .orderBy('created_at')
      .orderBy('role', 'desc')
      .execute(),
  );
}

describe('follow-up: email the earlier summary', () => {
  it.each([
    ['Summarize URL', 'email it to me', 'en'],
    ['Fasse URL zusammen', 'schick mir das', 'de'],
    ['لخص URL', 'أرسله لي', 'ar'],
  ] as const)('%s → %s', async (first, followUp, lang) => {
    const user = await connectedUser(lang);
    const url = h.site.url('/article');
    const s1 = await h.services.tasks.create(
      user,
      { request: first.replace('URL', url), source: 'text' },
      {},
    );
    await drain(h.worker);
    const summary = await detail(h.db, user, s1.id);
    expect(summary.status).toBe('COMPLETED');
    expect(summary.outcome).toBe('answer');
    const summaryText = String(summary.steps[1]!.output?.summary ?? '');
    expect(summaryText).toContain('Renewable sources generated more electricity than coal');

    const s2 = await h.services.tasks.followUp(
      user,
      summary.conversationId,
      { request: followUp, source: 'text' },
      {},
    );
    expect(s2.conversationId).toBe(summary.conversationId);
    await drain(h.worker);
    const waiting = await detail(h.db, user, s2.id);
    expect(waiting.planner).toEqual({ mode: 'offline', provider: null, model: null });
    const stored = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('tasks')
        .select(['language', 'conversation_id'])
        .where('id', '=', s2.id)
        .executeTakeFirstOrThrow(),
    );
    // "schick mir das" alone has few markers: the account locale decides.
    expect(stored).toEqual({ language: lang, conversation_id: summary.conversationId });
    expect(waiting.steps.map((s) => [s.toolId, s.status])).toEqual([
      ['conversation.recall', 'SUCCEEDED'],
      ['email.send', 'AWAITING_APPROVAL'],
    ]);
    expect(waiting.titleMessage?.key).toBe('plan.emailResult');
    const approval = waiting.approvals[0]!;
    expect(approval.reasons).toEqual(['RISK_MEDIUM', 'RECIPIENT_SELF']);
    if (approval.details.kind !== 'email') throw new Error('expected email details');
    expect(approval.details.to).toEqual([user.email]);
    // The full earlier result, recalled from the database (not the bounded context).
    expect(approval.details.body).toBe(summaryText);
    await h.services.approvals.decide(
      user,
      approval.id,
      { decision: 'approve', actionHash: approval.actionHash },
      'web',
    );
    await drain(h.worker);
    const done = await detail(h.db, user, s2.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.outcome).toBe('action');
    const sent = h.smtp.to(user.email);
    expect(sent).toHaveLength(1);
    expect(textBody(sent[0]!.raw).trim()).toBe(summaryText);
    expect(done.evidence.map((e) => e.code)).toEqual(['RECALLED_RESULT', 'SMTP_RECEIPT']);

    // The thread: request, answer, request, result — one JARVIS message per task.
    const thread = await messages(user, summary.conversationId);
    expect(thread.map((m) => [m.role, m.kind, m.task_id])).toEqual([
      ['user', 'request', s1.id],
      ['assistant', 'answer', s1.id],
      ['user', 'request', s2.id],
      ['assistant', 'result', s2.id],
    ]);
    expect(thread[1]!.content).toBe(summaryText);
    expect(thread[3]!.content_message).toMatchObject({ key: 'result.emailSent' });
    expect(thread.every((m) => m.language === lang)).toBe(true);
    const meta = await auditMetadata(user.userId, 'task.created');
    expect(meta.at(-1)).toMatchObject({ followUp: true, attachments: 0 });
    expect(JSON.stringify(meta)).not.toContain(followUp);
  });
});

describe('conversation rules', () => {
  it('refuses a follow-up while a task of the conversation is active (CONVERSATION_BUSY)', async () => {
    const user = await connectedUser();
    const s1 = await h.services.tasks.create(
      user,
      { request: `Summarize ${h.site.url('/article')} and email it to me`, source: 'text' },
      {},
    );
    await drain(h.worker); // waits for the email approval
    const d = await detail(h.db, user, s1.id);
    expect(d.status).toBe('AWAITING_APPROVAL');
    const err = await h.services.tasks
      .followUp(user, d.conversationId, { request: 'remember that', source: 'text' }, {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('INVALID_STATE');
    expect((err as AppError).details).toEqual({ reason: 'CONVERSATION_BUSY', taskId: s1.id });
  });

  it("is NOT_FOUND for another user's conversation, and replays an idempotency key", async () => {
    const alice = await connectedUser();
    const bob = await connectedUser();
    const s = await h.services.tasks.create(
      alice,
      { request: 'remember that I like tea', source: 'text' },
      {},
    );
    await drain(h.worker);
    const conversationId = (await detail(h.db, alice, s.id)).conversationId;
    const err = await h.services.tasks
      .followUp(bob, conversationId, { request: 'email it to me', source: 'text' }, {})
      .catch((e: unknown) => e);
    expect((err as AppError).code).toBe('NOT_FOUND');

    const first = await h.services.tasks.followUp(
      alice,
      conversationId,
      { request: 'remember that I like coffee', source: 'text' },
      { idempotencyKey: 'follow-1' },
    );
    const again = await h.services.tasks.followUp(
      alice,
      conversationId,
      { request: 'remember that I like coffee', source: 'text' },
      { idempotencyKey: 'follow-1' },
    );
    expect(again.id).toBe(first.id);
  });

  it('names the conversation after the first plan and bounds the planner context', async () => {
    const user = await connectedUser();
    const s1 = await h.services.tasks.create(
      user,
      { request: 'remember that I like tea', source: 'text' },
      {},
    );
    await drain(h.worker);
    const d1 = await detail(h.db, user, s1.id);
    const conversation = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('conversations')
        .select(['title', 'title_message'])
        .where('id', '=', d1.conversationId)
        .executeTakeFirstOrThrow(),
    );
    expect(conversation.title).toBe('Remember: I like tea');
    expect(conversation.title_message).toEqual({
      key: 'plan.remember',
      params: { text: 'I like tea' },
    });
    // Eight more turns: the context keeps the newest six, oldest first.
    const ids: string[] = [s1.id];
    for (let i = 0; i < 7; i++) {
      const s = await h.services.tasks.followUp(
        user,
        d1.conversationId,
        { request: `remember that note ${i} is kept`, source: 'text' },
        {},
      );
      ids.push(s.id);
      await drain(h.worker);
    }
    const turns = await withContext(h.db, user, (trx) =>
      loadConversationContext(trx, d1.conversationId, ids.at(-1)!),
    );
    expect(turns.map((t) => t.taskId)).toEqual(ids.slice(1, 7));
    expect(turns.every((t) => t.outcome === 'action' && !t.recallable)).toBe(true);
    // The title is not replaced by later plans.
    const after = await withContext(h.db, user, (trx) =>
      trx
        .selectFrom('conversations')
        .select('title')
        .where('id', '=', d1.conversationId)
        .executeTakeFirstOrThrow(),
    );
    expect(after.title).toBe('Remember: I like tea');
  });
});

describe('earlier results are untrusted content', () => {
  it('a result from a page with injected instructions needs approval even with auto-approval on; recipients stay literal', async () => {
    const user = await connectedUser('en', true);
    const s1 = await h.services.tasks.create(
      user,
      { request: `Summarize ${h.site.url('/injection')}`, source: 'text' },
      {},
    );
    await drain(h.worker);
    const d1 = await detail(h.db, user, s1.id);
    expect(d1.status).toBe('COMPLETED');
    const turns = await withContext(h.db, user, async (trx) => {
      const s = await h.services.tasks.followUp(
        user,
        d1.conversationId,
        { request: 'email it to me', source: 'text' },
        {},
      );
      return { id: s.id, ctx: await loadConversationContext(trx, d1.conversationId, s.id) };
    });
    expect(turns.ctx).toEqual([
      expect.objectContaining({ taskId: s1.id, flagged: true, recallable: true }),
    ]);
    await drain(h.worker);
    const waiting = await detail(h.db, user, turns.id);
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    expect(waiting.steps[0]!.output).toMatchObject({ suspectedInjection: true });
    const approval = waiting.approvals[0]!;
    expect(approval.reasons).toContain('UNTRUSTED_CONTENT');
    expect(approval.reasons).not.toContain('AUTO_APPROVED_SELF');
    expect(approval.details).toMatchObject({
      kind: 'email',
      to: [user.email],
      untrusted: { host: `127.0.0.1:${h.site.port}` },
    });
    expect(waiting.pendingApproval?.untrustedSource).toBe(true);
    expect(h.smtp.to('attacker@evil.test')).toHaveLength(0);
  });

  it('"remember that" asks to approve the exact text, and refuses flagged content', async () => {
    const user = await connectedUser();
    const clean = await h.services.tasks.create(
      user,
      { request: `Summarize ${h.site.url('/article')}`, source: 'text' },
      {},
    );
    await drain(h.worker);
    const conversationId = (await detail(h.db, user, clean.id)).conversationId;
    const s2 = await h.services.tasks.followUp(
      user,
      conversationId,
      { request: 'remember that', source: 'text' },
      {},
    );
    await drain(h.worker);
    const waiting = await detail(h.db, user, s2.id);
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    const approval = waiting.approvals[0]!;
    expect(approval.reasons).toEqual(['RISK_LOW', 'MEMORY_FROM_CONTENT']);
    expect(approval.summaryMessage?.key).toBe('approval.memory');
    if (approval.details.kind !== 'memory') throw new Error('expected memory details');
    expect(approval.details.sourceTaskId).toBe(clean.id);
    expect(approval.details.content).toContain('Renewable sources generated more electricity');
    await h.services.approvals.decide(
      user,
      approval.id,
      { decision: 'approve', actionHash: approval.actionHash },
      'web',
    );
    await drain(h.worker);
    expect((await detail(h.db, user, s2.id)).status).toBe('COMPLETED');
    const memories = await withContext(h.db, user, (trx) =>
      trx.selectFrom('memories').select(['content', 'source', 'source_task_id']).execute(),
    );
    expect(memories).toEqual([
      { content: approval.details.content, source: 'assistant', source_task_id: s2.id },
    ]);

    // From a page that tried to instruct the assistant: refused, nothing stored.
    const bad = await h.services.tasks.create(
      user,
      { request: `Summarize ${h.site.url('/injection')}`, source: 'text' },
      {},
    );
    await drain(h.worker);
    const badConversation = (await detail(h.db, user, bad.id)).conversationId;
    const s3 = await h.services.tasks.followUp(
      user,
      badConversation,
      { request: 'remember that', source: 'text' },
      {},
    );
    await drain(h.worker);
    const refused = await detail(h.db, user, s3.id);
    expect(refused.status).toBe('FAILED');
    expect(refused.error).toMatchObject({ code: 'POLICY_DENIED', reason: 'UNTRUSTED_MEMORY' });
    expect(refused.steps[1]).toMatchObject({ toolId: 'memory.save', status: 'BLOCKED' });
    const after = await withContext(h.db, user, (trx) =>
      trx.selectFrom('memories').select('id').execute(),
    );
    expect(after).toHaveLength(1);
  });
});

describe('model mode follow-ups', () => {
  const model = new ScriptedModel();
  let hm: Harness;
  beforeAll(async () => {
    hm = await createHarness({ adapter: model, env: { ANTHROPIC_API_KEY: 'sk-test-scripted' } });
  });
  afterAll(() => hm.close());

  it('gives the planner earlier turns as untrusted context and accepts only listed task ids', async () => {
    const user = await newUser(hm.db);
    await connectSmtp(hm.db, hm.secrets, user, hm.smtp.port);
    model.script = {
      object: () => ({
        title: 'Capital of France',
        objective: 'Answer.',
        steps: [
          {
            key: 's1',
            toolId: 'assistant.answer',
            title: 'Answer',
            input: { question: 'Capital of France?', language: 'en' },
          },
        ],
      }),
      text: () => 'Paris is the capital of France.',
    };
    const s1 = await hm.services.tasks.create(
      user,
      { request: 'What is the capital of France?', source: 'text' },
      {},
    );
    await drain(hm.worker);
    const d1 = await detail(hm.db, user, s1.id);
    expect(d1.outcome).toBe('answer');

    model.calls.length = 0;
    model.script = {
      object: () => ({
        title: 'Email the answer',
        objective: 'Send the earlier answer to the owner.',
        steps: [
          {
            key: 's1',
            toolId: 'conversation.recall',
            title: 'Get the answer',
            input: { taskId: s1.id },
          },
          {
            key: 's2',
            toolId: 'email.send',
            title: 'Email it',
            input: { to: [user.email], subject: 'Capital', body: '{{s1.text}}' },
          },
        ],
      }),
      text: () => 'Emailed the answer to you.',
    };
    const s2 = await hm.services.tasks.followUp(
      user,
      d1.conversationId,
      { request: 'email it to me', source: 'text' },
      {},
    );
    await drain(hm.worker);
    const planning = model.calls.find((c) => c.purpose === 'planning')!;
    expect(planning.system).toContain('### conversation.recall');
    expect(planning.user).toContain(
      `<turn task="${s1.id}" status="COMPLETED" outcome="answer" recallable="true">`,
    );
    expect(planning.user).toContain('<user_request>What is the capital of France?</user_request>');
    expect(planning.user).toContain(
      '<result trust="untrusted" flagged="false">Paris is the capital of France.</result>',
    );
    const waiting = await detail(hm.db, user, s2.id);
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    const approval = waiting.approvals[0]!;
    if (approval.details.kind !== 'email') throw new Error('expected email');
    expect(approval.details.body).toBe('Paris is the capital of France.');

    // A task id the context does not list (another conversation's, or invented) is refused.
    await hm.services.approvals.decide(
      user,
      approval.id,
      { decision: 'reject', actionHash: approval.actionHash },
      'web',
    );
    model.script = {
      object: () => ({
        title: 'Email',
        objective: 'Send.',
        steps: [
          {
            key: 's1',
            toolId: 'conversation.recall',
            title: 'Get',
            input: { taskId: '99999999-9999-4999-8999-999999999999' },
          },
          {
            key: 's2',
            toolId: 'email.send',
            title: 'Email',
            input: { to: [user.email], subject: 'x', body: '{{s1.text}}' },
          },
        ],
      }),
    };
    const s3 = await hm.services.tasks.followUp(
      user,
      d1.conversationId,
      { request: 'email it to me again', source: 'text' },
      {},
    );
    await drain(hm.worker);
    expect((await detail(hm.db, user, s3.id)).error).toMatchObject({
      code: 'MODEL_ERROR',
      reason: 'INVALID_PLAN',
    });
    expect(hm.smtp.to(user.email)).toHaveLength(0);
  });
});
