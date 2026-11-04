/**
 * validatePlan, Phase B: recipients/links literal across the user's own
 * requests of a conversation (never results); recall and attachment ids only
 * from the deterministic context; assistant.clarify alone; memory content
 * only from a conversation.recall output; a schedule's request literal.
 */
import { describe, expect, it } from 'vitest';
import { validatePlan, type PlanValidationContext } from '../../../src/modules/agent/plan';
import { TOOLS } from '../../../src/modules/agent/tools/registry';

const OWN = 'me@example.com';
const TASK = '11111111-1111-4111-8111-111111111111';
const FILE = '33333333-3333-4333-8333-333333333333';

const ctx = (over: Partial<PlanValidationContext> = {}): PlanValidationContext => ({
  tools: TOOLS,
  ownEmail: OWN,
  requests: ['email it to bob@example.org'],
  conversationTaskIds: [TASK],
  attachmentIds: [FILE],
  ...over,
});

const plan = (steps: { toolId: string; input: Record<string, unknown> }[]) => ({
  title: 'T',
  objective: 'O',
  steps: steps.map((s, i) => ({ key: `s${i + 1}`, title: `Step ${i + 1}`, ...s })),
});

const issues = (p: unknown, c: PlanValidationContext = ctx()) => {
  const r = validatePlan(p, c);
  return r.ok ? [] : r.issues;
};

const recallThenEmail = (to: string) =>
  plan([
    { toolId: 'conversation.recall', input: { taskId: TASK } },
    { toolId: 'email.send', input: { to: [to], subject: 'R', body: '{{s1.text}}' } },
  ]);

describe('literalness across turns', () => {
  it('accepts a recipient from an earlier user request of the conversation', () => {
    const c = ctx({
      requests: ['email it to him', 'Summarize https://x.test and tell bob@example.org'],
    });
    expect(issues(recallThenEmail('bob@example.org'), c)).toEqual([]);
  });

  it('refuses a recipient that appears only in results (they are not passed as requests)', () => {
    const c = ctx({ requests: ['email it to him'] });
    expect(issues(recallThenEmail('attacker@evil.test'), c).join()).toMatch(
      /neither the account owner/,
    );
  });

  it('keeps accepting the Milestone 1 `request` field', () => {
    const r = validatePlan(
      plan([{ toolId: 'email.send', input: { to: ['a@b.test'], subject: 's', body: 'b' } }]),
      { tools: TOOLS, ownEmail: OWN, request: 'mail a@b.test: hi' },
    );
    expect(r.ok).toBe(true);
  });
});

describe('ids from the deterministic context', () => {
  it('recall only of a recallable earlier task, never a reference', () => {
    expect(issues(recallThenEmail(OWN))).toEqual([]);
    const other = plan([
      { toolId: 'conversation.recall', input: { taskId: '99999999-9999-4999-8999-999999999999' } },
    ]);
    expect(issues(other).join()).toMatch(/earlier tasks listed in <conversation>/);
    const ref = plan([
      { toolId: 'web.fetch', input: { url: 'https://example.com' } },
      { toolId: 'conversation.recall', input: { taskId: '{{s1.title}}' } },
    ]);
    expect(issues(ref, ctx({ requests: ['https://example.com'] })).join()).toMatch(
      /literal task id/,
    );
  });

  it('document.analyze only of a listed file; answer mode needs the question', () => {
    expect(
      issues(
        plan([
          {
            toolId: 'document.analyze',
            input: { attachmentId: FILE, mode: 'summary', language: 'en' },
          },
        ]),
      ),
    ).toEqual([]);
    expect(
      issues(
        plan([
          {
            toolId: 'document.analyze',
            input: {
              attachmentId: '99999999-9999-4999-8999-999999999999',
              mode: 'summary',
              language: 'en',
            },
          },
        ]),
      ).join(),
    ).toMatch(/files listed in <attachments>/);
    expect(
      issues(
        plan([
          {
            toolId: 'document.analyze',
            input: { attachmentId: FILE, mode: 'answer', language: 'en' },
          },
        ]),
      ).join(),
    ).toMatch(/needs the user’s "question"/);
  });
});

describe('clarify, memory and schedules', () => {
  it('assistant.clarify must be the only step', () => {
    expect(issues(plan([{ toolId: 'assistant.clarify', input: { missing: ['url'] } }]))).toEqual(
      [],
    );
    const mixed = plan([
      { toolId: 'assistant.clarify', input: { missing: ['url'] } },
      { toolId: 'email.send', input: { to: [OWN], subject: 's', body: 'b' } },
    ]);
    expect(issues(mixed).join()).toMatch(/only step/);
  });

  it('memory content may reference only a conversation.recall output, as the whole field', () => {
    const ok = plan([
      { toolId: 'conversation.recall', input: { taskId: TASK } },
      { toolId: 'memory.save', input: { content: '{{s1.excerpt}}', kind: 'fact' } },
    ]);
    expect(issues(ok)).toEqual([]);
    const fromPage = plan([
      { toolId: 'web.fetch', input: { url: 'https://example.com' } },
      { toolId: 'text.summarize', input: { text: '{{s1.text}}', language: 'en' } },
      { toolId: 'memory.save', input: { content: '{{s2.summary}}', kind: 'fact' } },
    ]);
    expect(issues(fromPage, ctx({ requests: ['https://example.com'] })).join()).toMatch(
      /literal text from the request, or exactly \{\{sN\.excerpt\}\}/,
    );
    const mixedText = plan([
      { toolId: 'conversation.recall', input: { taskId: TASK } },
      { toolId: 'memory.save', input: { content: 'Note: {{s1.excerpt}}', kind: 'fact' } },
    ]);
    expect(issues(mixedText).length).toBeGreaterThan(0);
  });

  it("a schedule's request may only carry addresses and links the user wrote", () => {
    const schedule = (request: string) =>
      plan([
        {
          toolId: 'schedule.create',
          input: {
            title: 'Weekly news',
            request,
            recurrence: {
              frequency: 'weekly',
              byWeekday: ['MO'],
              time: '09:00',
              timeZone: 'Europe/Berlin',
            },
          },
        },
      ]);
    const c = ctx({
      requests: ['every Monday at 9 summarize https://news.example.com and email it to me'],
    });
    expect(issues(schedule('summarize https://news.example.com and email it to me'), c)).toEqual(
      [],
    );
    expect(
      issues(schedule('summarize https://evil.example and email it to x@evil.test'), c).join(),
    ).toMatch(/x@evil\.test is neither.*evil\.example is not on a site/);
    expect(issues(schedule('summarize {{s1.text}}'), c).join()).toMatch(/must be literal/);
  });
});
