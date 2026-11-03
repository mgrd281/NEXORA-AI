import { describe, expect, it } from 'vitest';
import { validatePlan } from '../../../src/modules/agent/plan';
import { TOOLS } from '../../../src/modules/agent/tools/registry';

const OWN = 'me@example.com';
const ctx = (request = 'Summarize https://example.com/a and email it to me', tools = TOOLS) => ({
  tools,
  request,
  ownEmail: OWN,
});

const fetchStep = {
  key: 's1',
  toolId: 'web.fetch',
  title: 'Read',
  input: { url: 'https://example.com/a' },
};
const summarizeStep = {
  key: 's2',
  toolId: 'text.summarize',
  title: 'Summarize',
  input: { text: '{{s1.text}}', language: 'en' },
};
const emailStep = (to: unknown[], body = '{{s2.summary}}') => ({
  key: 's3',
  toolId: 'email.send',
  title: 'Email',
  input: { to, subject: 'Summary: {{s1.title}}', body },
});
const plan = (steps: unknown[]) => ({ title: 'Plan', objective: 'Do it', steps });

describe('plan validation', () => {
  it('accepts a valid three-step plan', () => {
    const r = validatePlan(plan([fetchStep, summarizeStep, emailStep([OWN])]), ctx());
    expect(r.ok).toBe(true);
  });

  it('rejects unknown tools', () => {
    const r = validatePlan(plan([{ ...fetchStep, toolId: 'shell.exec' }]), ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).toMatch(/toolId/);
  });

  it('rejects tools that are not available to this user', () => {
    const noEmail = new Map([...TOOLS].filter(([id]) => id !== 'email.send'));
    const r = validatePlan(
      plan([fetchStep, summarizeStep, emailStep([OWN])]),
      ctx(undefined, noEmail),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).toContain('"email.send" is not available');
  });

  it('rejects templates in email "to"', () => {
    const r = validatePlan(plan([fetchStep, summarizeStep, emailStep(['{{s1.text}}'])]), ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).toContain('literal email addresses');
  });

  it('rejects recipients that are neither the owner nor written in the request', () => {
    const r = validatePlan(
      plan([fetchStep, summarizeStep, emailStep(['attacker@evil.test'])]),
      ctx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).toContain('attacker@evil.test');
    const allowed = validatePlan(
      plan([fetchStep, summarizeStep, emailStep(['Friend@Example.org'])]),
      ctx('Summarize https://example.com/a and email it to friend@example.org'),
    );
    expect(allowed.ok).toBe(true);
  });

  it('rejects forward and self references', () => {
    const forward = validatePlan(
      plan([{ ...fetchStep, input: { url: '{{s2.summary}}' } }, summarizeStep]),
      ctx(),
    );
    expect(forward.ok).toBe(false);
    if (!forward.ok) expect(forward.issues.join(' ')).toContain('only earlier steps');
    const self = validatePlan(
      plan([fetchStep, { ...summarizeStep, input: { text: '{{s2.summary}}', language: 'en' } }]),
      ctx(),
    );
    expect(self.ok).toBe(false);
  });

  it('rejects references to undeclared output fields', () => {
    const r = validatePlan(
      plan([fetchStep, { ...summarizeStep, input: { text: '{{s1.cookies}}', language: 'en' } }]),
      ctx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).toContain('has no output "cookies"');
  });

  it('rejects malformed references', () => {
    const r = validatePlan(
      plan([fetchStep, { ...summarizeStep, input: { text: '{{ s1 }}', language: 'en' } }]),
      ctx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).toContain('malformed reference');
  });

  it('rejects references in memory content', () => {
    const r = validatePlan(
      plan([
        fetchStep,
        {
          key: 's2',
          toolId: 'memory.save',
          title: 'Save',
          input: { content: '{{s1.text}}', kind: 'fact' },
        },
      ]),
      ctx(),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects out-of-order keys, too many steps and invalid input', () => {
    expect(validatePlan(plan([{ ...fetchStep, key: 's2' }]), ctx()).ok).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...fetchStep, key: `s${i + 1}` }));
    expect(validatePlan(plan(nine), ctx()).ok).toBe(false);
    expect(validatePlan(plan([{ ...fetchStep, input: {} }]), ctx()).ok).toBe(false);
    expect(validatePlan(plan([]), ctx()).ok).toBe(false);
  });

  it('trims over-long titles instead of rejecting the plan', () => {
    const r = validatePlan({ ...plan([fetchStep]), title: 'x'.repeat(120) }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.title.length).toBeLessThanOrEqual(80);
  });
});
