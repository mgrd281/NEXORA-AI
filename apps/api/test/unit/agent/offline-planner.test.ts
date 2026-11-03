import { describe, expect, it } from 'vitest';
import {
  detectLanguage,
  OFFLINE_UNSUPPORTED_MESSAGE,
  planOffline,
} from '../../../src/modules/agent/models/offline';
import { validatePlan } from '../../../src/modules/agent/plan';
import { TOOLS } from '../../../src/modules/agent/tools/registry';

const OWN = 'me@example.com';
const plan = (request: string, language: 'en' | 'de' | 'ar' = 'en') =>
  planOffline(request, { language, ownEmail: OWN });

function ok(request: string, language: 'en' | 'de' | 'ar' = 'en') {
  const r = plan(request, language);
  if (!r.ok) throw new Error(`expected a plan for: ${request} (${r.message})`);
  // Every offline plan must also pass the shared validator.
  const v = validatePlan(structuredClone(r.plan), { tools: TOOLS, request, ownEmail: OWN });
  if (!v.ok) throw new Error(`offline plan invalid: ${v.issues.join('; ')}`);
  return r.plan;
}

describe('offline planner — summarize a link', () => {
  it.each([
    ['Summarize https://example.com/article', 'en'],
    ['summarise https://example.com/article please', 'en'],
    ['Can you read https://example.com/article?', 'en'],
    ['open https://example.com/article', 'en'],
    ['TL;DR https://example.com/article', 'en'],
    ['Fasse https://example.com/article zusammen', 'de'],
    ['Bitte lies https://example.com/article', 'de'],
    ['Öffne https://example.com/article', 'de'],
    ['لخص https://example.com/article', 'ar'],
    ['اقرأ https://example.com/article', 'ar'],
  ] as const)('%s → fetch + summarize', (request, lang) => {
    const p = ok(request, lang);
    expect(p.steps.map((s) => s.toolId)).toEqual(['web.fetch', 'text.summarize']);
    expect(p.steps[0]!.input).toEqual({ url: 'https://example.com/article' });
    expect(p.steps[1]!.input).toMatchObject({ text: '{{s1.text}}', language: lang });
  });

  it.each([
    ['Summarize http://127.0.0.1:4599/article and email it to me', 'en'],
    ['Summarize https://example.com/a and send it to me.', 'en'],
    ['Please read https://example.com/a and mail me the summary', 'en'],
    ['Fasse https://example.com/a zusammen und schick mir die Zusammenfassung', 'de'],
    ['Lies https://example.com/a und sende sie mir per E-Mail', 'de'],
    ['لخص https://example.com/a وأرسله لي', 'ar'],
    ['لخّص https://example.com/a وأرسل الملخص إلى بريدي', 'ar'],
  ] as const)('%s → fetch + summarize + email to self', (request, lang) => {
    const p = ok(request, lang);
    expect(p.steps.map((s) => s.toolId)).toEqual(['web.fetch', 'text.summarize', 'email.send']);
    expect(p.steps[2]!.input.to).toEqual([OWN]);
    expect(String(p.steps[2]!.input.body)).toContain('{{s2.summary}}');
  });

  it('strips trailing punctuation from links and localises titles', () => {
    const p = ok('Fasse https://example.com/a), zusammen', 'de');
    expect(p.steps[0]!.input.url).toBe('https://example.com/a');
    expect(p.title).toBe('example.com zusammenfassen');
    expect(ok('لخص https://example.com/a', 'ar').title).toBe('تلخيص example.com');
    expect(ok('Summarize https://example.com/a', 'en').title).toBe('Summarize example.com');
  });

  it('accepts www. links', () => {
    expect(ok('summarize www.example.com/news').steps[0]!.input.url).toBe(
      'https://www.example.com/news',
    );
  });
});

describe('offline planner — memory', () => {
  it.each([
    ['remember that I prefer aisle seats', 'I prefer aisle seats', 'preference'],
    ['Please remember my passport expires in May 2027', 'my passport expires in May 2027', 'fact'],
    ["Don't forget that my sister's birthday is June 3", "my sister's birthday is June 3", 'fact'],
    ['Merk dir, dass ich Gangplätze bevorzuge', 'ich Gangplätze bevorzuge', 'preference'],
    ['merke dir: Mein Zahnarzt heißt Dr. Weber', 'Mein Zahnarzt heißt Dr. Weber', 'fact'],
    ['تذكر أن رقم غرفتي 214', 'رقم غرفتي 214', 'fact'],
    ['تذكّر أنني أفضل المقاعد بجانب الممر', 'أنني أفضل المقاعد بجانب الممر', 'preference'],
  ] as const)('%s', (request, content, kind) => {
    const p = ok(request);
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]!.toolId).toBe('memory.save');
    expect(p.steps[0]!.input).toEqual({ content, kind });
  });

  it('a memory containing a link is still a memory', () => {
    const p = ok('remember that my blog is https://blog.example.com');
    expect(p.steps.map((s) => s.toolId)).toEqual(['memory.save']);
  });
});

describe('offline planner — email me', () => {
  it.each([
    ['email me: buy milk and eggs', 'buy milk and eggs', 'buy milk and eggs'],
    [
      'Email me a reminder about the dentist: Thursday 3pm',
      'Thursday 3pm',
      'Reminder about the dentist',
    ],
    [
      'Schick mir eine Notiz: Steuererklärung abgeben',
      'Steuererklärung abgeben',
      'Steuererklärung abgeben',
    ],
    ['أرسل لي: اتصل بأحمد غدا', 'اتصل بأحمد غدا', 'اتصل بأحمد غدا'],
  ] as const)('%s', (request, body, subject) => {
    const p = ok(request);
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]!.toolId).toBe('email.send');
    expect(p.steps[0]!.input).toEqual({ to: [OWN], subject, body });
  });

  it('an email note that only mentions a link is sent, not summarized', () => {
    const p = ok('email me: check https://example.com/tickets tomorrow');
    expect(p.steps.map((s) => s.toolId)).toEqual(['email.send']);
  });
});

describe('offline planner — unsupported', () => {
  it.each([
    'What is the weather in Paris?',
    'Wie spät ist es in Tokio?',
    'ما هي عاصمة فرنسا؟',
    'book a flight to Rome',
  ])('%s → PLANNER_UNSUPPORTED', (request) => {
    const r = plan(request);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('PLANNER_UNSUPPORTED');
      expect(r.message).toBe(OFFLINE_UNSUPPORTED_MESSAGE);
    }
  });
});

describe('language detection', () => {
  it.each([
    ['Summarize https://example.com and email it to me', 'en'],
    ['Fasse https://example.com zusammen und schick sie mir', 'de'],
    ['merk dir dass ich Tee mag', 'de'],
    ['لخص https://example.com', 'ar'],
    ['https://example.com', 'de'],
  ] as const)('%s → %s', (text, expected) => {
    expect(detectLanguage(text, 'de')).toBe(expected);
  });
});
