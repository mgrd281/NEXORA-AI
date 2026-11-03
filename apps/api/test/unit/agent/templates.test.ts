import { describe, expect, it } from 'vitest';
import { AgentError } from '../../../src/modules/agent/errors';
import {
  findMalformedRefs,
  findRefs,
  hasTemplate,
  resolveTemplates,
} from '../../../src/modules/agent/templates';

describe('step references', () => {
  it('finds references in nested inputs', () => {
    expect(
      findRefs({ a: '{{s1.text}}', b: ['x {{ s2.summary }} y', { c: '{{s1.title}}' }], n: 3 }),
    ).toEqual([
      { stepKey: 's1', field: 'text' },
      { stepKey: 's2', field: 'summary' },
      { stepKey: 's1', field: 'title' },
    ]);
  });

  it('detects malformed references', () => {
    expect(findMalformedRefs({ a: '{{s1}}', b: 'ok {{s1.text}}', c: ['}} stray'] })).toEqual([
      'a',
      'c[0]',
    ]);
    expect(hasTemplate('no refs')).toBe(false);
    expect(hasTemplate('{{s1.text}}')).toBe(true);
  });

  it('resolves whole-string and embedded references', () => {
    const out = resolveTemplates(
      { text: '{{s1.text}}', subject: 'Summary: {{s1.title}} ({{s1.status}})', to: ['me@x.test'] },
      { s1: { text: 'Hello', title: 'News', status: 200 } },
    );
    expect(out).toEqual({ text: 'Hello', subject: 'Summary: News (200)', to: ['me@x.test'] });
  });

  it('is a single pass: substituted content is never expanded again', () => {
    const out = resolveTemplates(
      { body: '{{s1.text}}' },
      { s1: { text: 'evil {{s1.secret}} and {{s2.x}}', secret: 'SECRET' } },
    );
    expect(out).toEqual({ body: 'evil {{s1.secret}} and {{s2.x}}' });
  });

  it('throws a user-safe error when an output is missing', () => {
    expect(() => resolveTemplates({ a: '{{s3.text}}' }, { s1: { text: 'x' } })).toThrow(AgentError);
    expect(() => resolveTemplates({ a: '{{s1.nope}}' }, { s1: { text: 'x' } })).toThrow(
      /not available/,
    );
  });

  it('does not mutate the input', () => {
    const input = { a: '{{s1.text}}' };
    resolveTemplates(input, { s1: { text: 'x' } });
    expect(input.a).toBe('{{s1.text}}');
  });
});
