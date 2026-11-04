/**
 * Model mode end to end with a scripted adapter (no network): model planning,
 * streamed answers stored on the task, model summaries, metering into
 * usage_events/cost_records/actual_cost, budget policy, refusals, and routing
 * back to offline when the monthly budget is used up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createListener } from '../../../src/db/listener';
import { withContext } from '../../../src/db/pool';
import { AgentError } from '../../../src/modules/agent/errors';
import { EVENTS_CHANNEL } from '../../../src/modules/events/events';
import { ScriptedModel, usage } from '../../fixtures/scripted-model';
import { TEST_APP_URL } from '../env';
import {
  connectSmtp,
  connectWeb,
  createHarness,
  detail,
  drain,
  newUser,
  type Harness,
} from './harness';

const model = new ScriptedModel();
let h: Harness;

beforeAll(async () => {
  h = await createHarness({ adapter: model, env: { ANTHROPIC_API_KEY: 'sk-test-scripted' } });
});
afterAll(() => h.close());

async function metering(user: { tenantId: string; userId: string }, taskId: string) {
  return withContext(h.db, user, async (trx) => ({
    usage: await trx
      .selectFrom('usage_events')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at')
      .execute(),
    costs: await trx.selectFrom('cost_records').selectAll().where('task_id', '=', taskId).execute(),
    task: await trx
      .selectFrom('tasks')
      .select(['actual_cost_micro', 'estimated_cost_micro', 'answer'])
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow(),
  }));
}

describe('model mode', () => {
  it('answers a question with a streamed answer and meters every model call', async () => {
    const user = await newUser(h.db);
    model.script = {
      object: () => ({
        title: 'Capital of France',
        objective: 'Answer the question.',
        steps: [
          {
            key: 's1',
            toolId: 'assistant.answer',
            title: 'Answer',
            input: { question: 'What is the capital of France?', language: 'en' },
          },
        ],
      }),
      text: () => 'Paris is the capital of France.',
    };
    model.calls.length = 0;

    const listener = createListener(TEST_APP_URL);
    const deltas: string[] = [];
    let resolveDone: () => void = () => {};
    const gotAll = new Promise<void>((r) => (resolveDone = r));
    await listener.listen(EVENTS_CHANNEL, (payload) => {
      const msg = JSON.parse(payload) as {
        u: string;
        e?: { type: string; data: { text: string } };
      };
      if (msg.u === user.userId && msg.e?.type === 'task.answer.delta') {
        deltas.push(msg.e.data.text);
        if (deltas.join('') === 'Paris is the capital of France.') resolveDone();
      }
    });
    try {
      const s = await h.services.tasks.create(
        user,
        { request: 'What is the capital of France?', source: 'text' },
        {},
      );
      await drain(h.worker);
      const done = await detail(h.db, user, s.id);
      expect(done.status).toBe('COMPLETED');
      expect(done.planner).toEqual({
        mode: 'model',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
      });
      expect(done.title).toBe('Capital of France');
      expect(done.answer).toBe('Paris is the capital of France.');
      expect(done.resultSummary).toBe('Paris is the capital of France.');
      expect(done.evidence.map((e) => e.kind)).toEqual(['model_output']);

      // Planning on the deep tier, the answer on the balanced tier; no extra result-summary call.
      expect(model.calls.map((c) => [c.purpose, c.model])).toEqual([
        ['planning', 'claude-opus-5-5'],
        ['answer', 'claude-sonnet-5-5'],
      ]);
      // The planner prompt carries the catalog of available tools only (no smtp/web connected).
      expect(model.calls[0]!.system).toContain('### assistant.answer');
      expect(model.calls[0]!.system).not.toContain('### email.send');
      expect(model.calls[0]!.system).not.toContain('### web.fetch');

      const m = await metering(user, s.id);
      expect(m.usage.map((u) => [u.model, u.input_tokens, u.output_tokens])).toEqual([
        ['claude-opus-5-5', 2_000, 600],
        ['claude-sonnet-5-5', 1_500, 300],
      ]);
      const planning = 2_000 * 4 + 600 * 20; // 20,000 µ$
      const answer = 1_500 * 2 + 300 * 10; // 6,000 µ$
      expect(m.costs.map((c) => c.amount_micro).sort((a, b) => a - b)).toEqual([answer, planning]);
      expect(m.costs.every((c) => c.category === 'model' && c.usage_event_id)).toBe(true);
      expect(m.task.actual_cost_micro).toBe(planning + answer);
      expect(m.task.estimated_cost_micro).toBeGreaterThan(planning);

      await Promise.race([
        gotAll,
        new Promise((_, rej) => setTimeout(() => rej(new Error('no deltas')), 5_000)),
      ]);
      expect(deltas.join('')).toBe('Paris is the capital of France.');
    } finally {
      await listener.close();
    }
  });

  it('summarizes with the fast tier and writes the result line with the model', async () => {
    const user = await newUser(h.db);
    await connectWeb(h.db, user);
    await connectSmtp(h.db, h.secrets, user, h.smtp.port);
    const url = h.site.url('/article');
    model.calls.length = 0;
    model.script = {
      object: () => ({
        title: 'Summarize the article and email it',
        objective: 'Read, summarize, email to the owner.',
        steps: [
          { key: 's1', toolId: 'web.fetch', title: 'Read the article', input: { url } },
          {
            key: 's2',
            toolId: 'text.summarize',
            title: 'Summarize',
            input: { text: '{{s1.text}}', title: '{{s1.title}}', language: 'en' },
          },
          {
            key: 's3',
            toolId: 'email.send',
            title: 'Email the summary',
            input: { to: [user.email], subject: 'Summary: {{s1.title}}', body: '{{s2.summary}}' },
          },
        ],
      }),
      text: (req) =>
        req.purpose === 'summarize'
          ? 'A report on European electricity.\n- Renewables beat coal for the first time.'
          : 'I summarized the article and emailed it to you.',
    };
    const s = await h.services.tasks.create(
      user,
      { request: `Summarize ${url} and email it to me`, source: 'text' },
      {},
    );
    await drain(h.worker);
    const waiting = await detail(h.db, user, s.id);
    expect(waiting.status).toBe('AWAITING_APPROVAL');
    expect(waiting.steps[1]!.output).toMatchObject({ method: 'model', model: 'claude-haiku-5-5' });
    // The untrusted page text reached the summarizer only inside data tags.
    const summarizeCall = model.calls.find((c) => c.purpose === 'summarize')!;
    expect(summarizeCall.user).toMatch(/^<document title="Renewables overtake coal in Europe">/);
    expect(summarizeCall.system).toContain('untrusted data');

    const approval = waiting.approvals[0]!;
    await h.services.approvals.decide(
      user,
      approval.id,
      { decision: 'approve', actionHash: approval.actionHash },
      'web',
    );
    await drain(h.worker);
    const done = await detail(h.db, user, s.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.resultSummary).toBe('I summarized the article and emailed it to you.');
    expect(model.calls.map((c) => c.purpose)).toEqual(['planning', 'summarize', 'result_summary']);
    expect((await metering(user, s.id)).usage).toHaveLength(3);
    expect(h.smtp.to(user.email)).toHaveLength(1);
  });

  it('asks for approval when the projected cost exceeds the remaining budget', async () => {
    const user = await newUser(h.db, {
      spending: { monthlyAiBudgetUsd: 0.03, monthlyPurchaseLimitUsd: 0 },
    }); // 30,000 µ$
    model.script = {
      object: () => ({
        title: 'Explain',
        objective: 'Answer.',
        steps: [
          {
            key: 's1',
            toolId: 'assistant.answer',
            title: 'Answer',
            input: { question: 'Explain tides', language: 'en' },
          },
        ],
      }),
      text: () => 'Tides are caused by the Moon.',
    };
    const s = await h.services.tasks.create(user, { request: 'Explain tides', source: 'text' }, {});
    await drain(h.worker);
    const d = await detail(h.db, user, s.id);
    // Planning cost 20,000 µ$ leaves 10,000; the answer is estimated at 29,000 µ$.
    expect(d.status).toBe('AWAITING_APPROVAL');
    const approval = d.approvals[0]!;
    expect(approval.reasons).toEqual(['RISK_LOW', 'BUDGET_NEAR_LIMIT']);
    expect(approval.details).toMatchObject({ kind: 'generic', toolId: 'assistant.answer' });
  });

  it('a refusal during planning fails the task with MODEL_ERROR and is still billed', async () => {
    const user = await newUser(h.db);
    model.script = {
      object: () => {
        throw new AgentError('MODEL_ERROR', 'The model declined this request.', {
          usage: [usage('planning', 'claude-opus-5-5', 500, 20)],
        });
      },
    };
    const s = await h.services.tasks.create(
      user,
      { request: 'Something the model declines', source: 'text' },
      {},
    );
    await drain(h.worker);
    const d = await detail(h.db, user, s.id);
    expect(d.status).toBe('FAILED');
    expect(d.error).toEqual({
      code: 'MODEL_ERROR',
      message: 'The model declined this request.',
      retryable: false,
    });
    const m = await metering(user, s.id);
    expect(m.costs.map((c) => c.amount_micro)).toEqual([500 * 4 + 20 * 20]);
    expect(m.task.actual_cost_micro).toBe(2_400);
  });

  it('falls back to the offline planner once the monthly budget is used up', async () => {
    const user = await newUser(h.db, {
      spending: { monthlyAiBudgetUsd: 1, monthlyPurchaseLimitUsd: 0 },
    });
    await withContext(h.db, user, (trx) =>
      trx
        .insertInto('cost_records')
        .values({
          tenant_id: user.tenantId,
          user_id: user.userId,
          category: 'model',
          amount_micro: 1_000_000,
        })
        .execute(),
    );
    model.calls.length = 0;
    expect((await h.services.status.get(user)).planner).toEqual({
      mode: 'offline',
      provider: null,
      reason: 'BUDGET_EXHAUSTED',
    });
    const s = await h.services.tasks.create(
      user,
      { request: 'remember that the budget is spent', source: 'text' },
      {},
    );
    await drain(h.worker);
    const d = await detail(h.db, user, s.id);
    expect(d.status).toBe('COMPLETED');
    expect(d.planner).toEqual({ mode: 'offline', provider: null, model: null });
    expect(model.calls).toHaveLength(0);
  });
});
