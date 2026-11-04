/**
 * Telemetry never records content: the redaction layer under every span
 * attribute, metric label and error report.
 */
import { describe, expect, it } from 'vitest';
import {
  errorType,
  labelValue,
  pathOnly,
  REDACTED,
  safeKey,
  sanitizeAttributes,
  scrubSentryEvent,
  scrubText,
  type ScrubbableEvent,
} from '../../../src/observability/redact';

describe('sanitizeAttributes', () => {
  it('keeps bounded ids, enums, model names, route templates and numbers', () => {
    const attrs = {
      'jarvis.job.kind': 'task.execute',
      'jarvis.job.id': 42,
      'jarvis.task_id': '0b6f1c1e-7d1a-4c55-9d0e-2a8b6f0e9c11',
      'jarvis.tool.id': 'email.send',
      'gen_ai.request.model': 'claude-opus-5-5',
      'gen_ai.usage.input_tokens': 1234,
      'gen_ai.usage.output_tokens': 56,
      'gen_ai.response.finish_reasons': 'end_turn',
      'http.route': '/v1/tasks/:id',
      'http.response.status_code': 200,
      'jarvis.retryable': true,
    };
    expect(sanitizeAttributes(attrs)).toEqual(attrs);
  });

  it('drops keys that name content, whatever their value', () => {
    const out = sanitizeAttributes({
      'url.full': 'x',
      'http.url': 'x',
      'jarvis.task.title': 'x',
      'email.to': 'x',
      'gen_ai.prompt': 'x',
      'gen_ai.completion': 'x',
      'jarvis.memory.content': 'x',
      'jarvis.attachment.filename': 'x',
      'db.query': 'x',
      'http.request.header.authorization': 'x',
      'server.host': 'x',
      'jarvis.result': 'x',
      'Bad Key': 'x',
      'jarvis.ok': 'kept',
    });
    expect(out).toEqual({ 'jarvis.ok': 'kept' });
  });

  it('compares key segments whole (input_tokens is not "input")', () => {
    expect(safeKey('gen_ai.usage.input_tokens')).toBe(true);
    expect(safeKey('jarvis.input')).toBe(false);
    expect(safeKey('jarvis.output_count')).toBe(true);
  });

  it('replaces values that look like content', () => {
    const out = sanitizeAttributes({
      'jarvis.a': 'Summarize the article about renewables',
      'jarvis.b': 'someone@example.com',
      'jarvis.c': 'https://example.com/a?b=c',
      'jarvis.d': 'q=search+terms&x=1',
      'jarvis.e': 'x'.repeat(200),
      'jarvis.f': 'line\nbreak',
      'jarvis.g': Number.NaN,
      'jarvis.h': { nested: true } as unknown as string,
      'jarvis.i': '50%',
    });
    for (const v of Object.values(out)) expect(v).toBe(REDACTED);
    expect(Object.keys(out)).toHaveLength(9);
  });

  it('skips null and undefined and caps the number of attributes', () => {
    const many: Record<string, unknown> = { 'jarvis.none': undefined, 'jarvis.null': null };
    for (let i = 0; i < 100; i++) many[`jarvis.k${i}`] = i;
    const out = sanitizeAttributes(many);
    expect(out['jarvis.none']).toBeUndefined();
    expect(Object.keys(out)).toHaveLength(32);
  });
});

describe('labelValue', () => {
  it('passes bounded values and maps everything else to "other"', () => {
    expect(labelValue('listTasks')).toBe('listTasks');
    expect(labelValue(404)).toBe('404');
    expect(labelValue('claude-haiku-5-5')).toBe('claude-haiku-5-5');
    expect(labelValue('https://evil.test/x')).toBe('other');
    expect(labelValue('a b')).toBe('other');
    expect(labelValue('')).toBe('other');
    expect(labelValue(undefined)).toBe('other');
    expect(labelValue('x'.repeat(100))).toHaveLength(64);
  });
});

describe('errorType', () => {
  it('uses the code or class name, never the message', () => {
    expect(errorType(Object.assign(new Error('secret text'), { code: 'MODEL_ERROR' }))).toBe(
      'MODEL_ERROR',
    );
    expect(errorType(new TypeError('to someone@example.com'))).toBe('TypeError');
    expect(errorType(Object.assign(new Error('x'), { code: 'has space' }))).toBe('Error');
    expect(errorType('a string')).toBe('Error');
  });
});

describe('scrubText', () => {
  it('removes addresses, links, credentials and long numbers', () => {
    const text =
      'Failed to send to anna@example.com via https://smtp.example.com:465/x?token=abc ' +
      '(www.example.org/page) Authorization: Bearer abc.def.ghi password=hunter2 ' +
      'secret: "s3cr3t" whsec_dGVzdHNlY3JldA== sk-ant-api03-abcdefghijk card 4111111111111111';
    const out = scrubText(text);
    expect(out).not.toMatch(
      /anna|example\.com|example\.org|abc\.def|hunter2|s3cr3t|whsec_|sk-ant|4111/,
    );
    expect(out).toContain('[email]');
    expect(out).toContain('[url]');
    expect(out).toContain('password=[redacted]');
    expect(out).toContain('[number]');
  });

  it('truncates long text', () => {
    expect(scrubText('a'.repeat(2_000)).length).toBeLessThanOrEqual(512);
  });
});

describe('pathOnly', () => {
  it('drops query strings and fragments, and the host of absolute URLs', () => {
    expect(pathOnly('/v1/conversations?q=my+secret+search')).toBe('/v1/conversations');
    expect(pathOnly('/v1/tasks/1#frag')).toBe('/v1/tasks/1');
    expect(pathOnly('https://api.example.com/v1/tasks?x=1')).toBe('/v1/tasks');
  });
});

describe('scrubSentryEvent', () => {
  it('drops request data, cookies, headers, query, user email/IP, breadcrumbs, extras and variables', () => {
    const event: ScrubbableEvent = {
      message: 'Could not email bob@example.com',
      logentry: { message: 'see https://example.com/?q=1', params: ['bob@example.com'] },
      request: {
        method: 'POST',
        url: 'https://api.jarvis.test/v1/tasks?q=private+words',
        data: '{"request":"Summarize my diary"}',
        query_string: 'q=private+words',
        cookies: { jarvis_session: 'abc' },
        headers: {
          authorization: 'Bearer abc',
          cookie: 'jarvis_session=abc',
          'content-type': 'application/json',
          'user-agent': 'Mozilla/5.0',
          'x-forwarded-for': '203.0.113.9',
        },
        env: { REMOTE_ADDR: '203.0.113.9' },
      },
      user: { id: 'u-1', email: 'anna@example.com', ip_address: '203.0.113.9', username: 'anna' },
      breadcrumbs: [{ message: 'GET https://example.com/?q=secret' }],
      extra: { body: 'the email body' },
      tags: { 'jarvis.route': 'createTask', 'jarvis.subject': 'Quarterly numbers', bad: 'a b' },
      contexts: {
        runtime: { name: 'node' },
        os: { name: 'linux' },
        response: { body: 'x' },
        state: { memories: ['x'] },
      },
      exception: {
        values: [
          {
            type: 'Error',
            value: 'boom for someone@example.com at https://secret.example/path?q=hidden',
            stacktrace: {
              frames: [
                {
                  filename: 'app.js',
                  vars: { password: 'hunter2' },
                  pre_context: ['const a = 1;'],
                  context_line: "throw new Error('hunter2')",
                  post_context: ['}'],
                },
              ],
            },
          },
        ],
      },
    };
    const out = scrubSentryEvent(event);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(
      /private|diary|jarvis_session|Bearer|Mozilla|203\.0\.113|anna|bob@|hunter2|Quarterly|email body|secret\.example|memories/,
    );
    expect(out.request).toEqual({
      method: 'POST',
      url: '/v1/tasks',
      headers: { 'content-type': 'application/json' },
    });
    expect(out.user).toEqual({ id: 'u-1' });
    expect(out.breadcrumbs).toBeUndefined();
    expect(out.extra).toBeUndefined();
    expect(out.tags).toEqual({ 'jarvis.route': 'createTask', bad: REDACTED });
    expect(Object.keys(out.contexts ?? {}).sort()).toEqual(['os', 'runtime']);
    expect(out.exception?.values?.[0]?.value).toBe('boom for [email] at [url]');
    expect(out.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({ filename: 'app.js' });
  });
});
