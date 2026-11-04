/**
 * Clarifying questions end to end: "email me" with no content completes with
 * outcome 'question' (never inventing content), the question as a localisable
 * message and JARVIS's question in the thread; the answer, a follow-up,
 * becomes the email. A recipient that is not literally present is asked for.
 * Model mode: the scripted planner asks with its own words.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '../../../src/db/pool';
import { render } from '../../../src/modules/agent/i18n';
import { ScriptedModel } from '../../fixtures/scripted-model';
import { textBody } from '../../fixtures/smtp-sink';
import { connectSmtp, createHarness, detail, drain, newUser, type Harness } from './harness';

let h: Harness;
const model = new ScriptedModel();
let hm: Harness;
beforeAll(async () => {
  h = await createHarness();
  hm = await createHarness({ adapter: model, env: { ANTHROPIC_API_KEY: 'sk-test-scripted' } });
});
afterAll(async () => {
  await h.close();
  await hm.close();
});

describe('clarifying questions', () => {
  it.each([
    ['email me', 'en'],
    ['schick mir eine E-Mail', 'de'],
    ['أرسل لي بريدا', 'ar'],
  ] as const)(
    '"%s" asks what the email should say, and the answer is sent',
    async (request, lang) => {
      const user = await newUser(h.db, { autonomy: { autoApproveEmailToSelf: true } });
      await connectSmtp(h.db, h.secrets, user, h.smtp.port);
      const s1 = await h.services.tasks.create(
        user,
        { request, source: 'text', language: lang },
        {},
      );
      await drain(h.worker);
      const asked = await detail(h.db, user, s1.id);
      expect(asked.status).toBe('COMPLETED');
      expect(asked.outcome).toBe('question');
      expect(asked.question).toEqual({
        text: render(lang, { key: 'question.emailContent', params: {} }),
        message: { key: 'question.emailContent', params: {} },
        missing: ['email_content'],
      });
      expect(asked.resultSummaryMessage).toEqual({ key: 'question.emailContent', params: {} });
      expect(asked.steps.map((s) => s.toolId)).toEqual(['assistant.clarify']);
      expect(asked.evidence.map((e) => e.code)).toEqual(['QUESTION_ASKED']);
      expect(h.smtp.to(user.email)).toHaveLength(0); // nothing invented, nothing sent
      const thread = await withContext(h.db, user, (trx) =>
        trx
          .selectFrom('messages')
          .select(['role', 'kind', 'content_message'])
          .where('task_id', '=', s1.id)
          .orderBy('created_at')
          .execute(),
      );
      expect(thread).toEqual([
        { role: 'user', kind: 'request', content_message: null },
        {
          role: 'assistant',
          kind: 'question',
          content_message: { key: 'question.emailContent', params: {} },
        },
      ]);

      const s2 = await h.services.tasks.followUp(
        user,
        asked.conversationId,
        { request: 'Pay the electricity bill on Friday', source: 'text', language: lang },
        {},
      );
      await drain(h.worker);
      const sent = await detail(h.db, user, s2.id);
      expect(sent.status).toBe('COMPLETED');
      expect(sent.outcome).toBe('action');
      const mails = h.smtp.to(user.email);
      expect(mails).toHaveLength(1);
      expect(textBody(mails[0]!.raw).trim()).toBe('Pay the electricity bill on Friday');
    },
  );

  it('asks for a recipient address instead of guessing one', async () => {
    const user = await newUser(h.db);
    await connectSmtp(h.db, h.secrets, user, h.smtp.port);
    const s1 = await h.services.tasks.create(
      user,
      { request: 'remember that I like tea', source: 'text' },
      {},
    );
    await drain(h.worker);
    const conversationId = (await detail(h.db, user, s1.id)).conversationId;
    // Nothing recallable yet: which result?
    const s2 = await h.services.tasks.followUp(
      user,
      conversationId,
      { request: 'send it to Bob', source: 'text' },
      {},
    );
    await drain(h.worker);
    expect((await detail(h.db, user, s2.id)).question?.missing).toEqual(['previous_result']);
  });

  it('model mode: the planner asks in its own words (assistant.clarify), nothing else runs', async () => {
    const user = await newUser(hm.db);
    await connectSmtp(hm.db, hm.secrets, user, hm.smtp.port);
    model.calls.length = 0;
    model.script = {
      object: () => ({
        title: 'Email to Bob',
        objective: 'Ask for the missing address.',
        steps: [
          {
            key: 's1',
            toolId: 'assistant.clarify',
            title: 'Ask for the address',
            input: { missing: ['recipient'], question: 'What is Bob’s email address?' },
          },
        ],
      }),
    };
    const s = await hm.services.tasks.create(
      user,
      { request: 'Email Bob that I am late', source: 'text' },
      {},
    );
    await drain(hm.worker);
    const d = await detail(hm.db, user, s.id);
    expect(d.status).toBe('COMPLETED');
    expect(d.question).toEqual({
      text: 'What is Bob’s email address?',
      message: null,
      missing: ['recipient'],
    });
    expect(d.resultSummary).toBe('What is Bob’s email address?');
    // The planner was told to ask rather than guess; no result-line model call for a question.
    expect(model.calls.map((c) => c.purpose)).toEqual(['planning']);
    expect(model.calls[0]!.system).toContain('plan a single assistant.clarify step');
    expect(model.calls[0]!.system).toContain('### assistant.clarify');
  });

  it('model mode: an invented recipient fails validation; the repair prompt suggests asking', async () => {
    const user = await newUser(hm.db);
    await connectSmtp(hm.db, hm.secrets, user, hm.smtp.port);
    model.calls.length = 0;
    let n = 0;
    model.script = {
      object: () =>
        n++ === 0
          ? {
              title: 'Email Bob',
              objective: 'Send.',
              steps: [
                {
                  key: 's1',
                  toolId: 'email.send',
                  title: 'Send',
                  input: { to: ['bob@guessed.example'], subject: 'Late', body: 'I am late.' },
                },
              ],
            }
          : {
              title: 'Email Bob',
              objective: 'Ask.',
              steps: [
                {
                  key: 's1',
                  toolId: 'assistant.clarify',
                  title: 'Ask',
                  input: { missing: ['recipient'] },
                },
              ],
            },
    };
    const s = await hm.services.tasks.create(
      user,
      { request: 'Email Bob that I am late', source: 'text' },
      {},
    );
    await drain(hm.worker);
    const d = await detail(hm.db, user, s.id);
    expect(d.outcome).toBe('question');
    expect(d.question?.message).toEqual({ key: 'question.recipient', params: {} });
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.user).toContain(
      'recipient bob@guessed.example is neither the account owner',
    );
    expect(model.calls[1]!.user).toContain(
      'plan a single assistant.clarify step with missing ["recipient"]',
    );
    expect(hm.smtp.to('bob@guessed.example')).toHaveLength(0);
  });
});
