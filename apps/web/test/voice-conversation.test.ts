/**
 * Voice conversation mode (docs/architecture/phase-d.md §3.1): the text rules and the state
 * machine, driven deterministically with fake recognition, synthesis and timers.
 */
import type { TaskStatus } from '@jarvis/contracts';
import { VOICE_LIMITS } from '@jarvis/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readResultEvent, voicesFor } from '@/components/voice/engine/browser';
import {
  ConversationController,
  type ConversationDeps,
  type ConversationEnd,
  type SubmitRequest,
  type TaskView,
} from '@/components/voice/engine/controller';
import {
  chunkForSpeech,
  isAffirmation,
  isEcho,
  isStopPhrase,
  normalizeUtterance,
  takeSentences,
} from '@/components/voice/engine/text';
import { FakeRecognizer, FakeSynth } from './support/fake-speech';

/* ------------------------------------------------------------------ text */

describe('utterance rules', () => {
  it('normalises case, punctuation and diacritics the same way on both sides', () => {
    expect(normalizeUtterance('  Stopp!  ')).toBe('stopp');
    expect(normalizeUtterance('Gespräch   beenden.')).toBe('gesprach beenden');
    expect(normalizeUtterance('أنهِ المحادثة.')).toBe('انه المحادثه');
    expect(normalizeUtterance('توقّف')).toBe('توقف');
  });

  it('recognises every stop phrase of each language as a whole utterance only', () => {
    for (const [locale, phrases] of Object.entries(VOICE_LIMITS.stopPhrases)) {
      for (const phrase of phrases) {
        expect(isStopPhrase(phrase, locale as 'en' | 'de' | 'ar'), `${locale}: ${phrase}`).toBe(
          true,
        );
      }
    }
    expect(isStopPhrase('Stop.', 'en')).toBe(true);
    expect(isStopPhrase('STOPP', 'de')).toBe(true);
    expect(isStopPhrase('توقف!', 'ar')).toBe(true);
    expect(isStopPhrase('أنه المحادثة', 'ar')).toBe(true);
    // Part of a request is not a command.
    expect(isStopPhrase('stop the timer at five', 'en')).toBe(false);
    expect(isStopPhrase('stopp', 'en')).toBe(false);
    expect(isStopPhrase('', 'en')).toBe(false);
  });

  it('knows spoken assent (which is never an approval)', () => {
    expect(isAffirmation('Yes.', 'en')).toBe(true);
    expect(isAffirmation('Yes, approve it.', 'en')).toBe(true);
    expect(isAffirmation('Ja, genehmigen!', 'de')).toBe(true);
    expect(isAffirmation('نعم، موافق', 'ar')).toBe(true);
    // Anything with content is not just assent: it waits in the text field.
    expect(isAffirmation('yes send it to Omar', 'en')).toBe(false);
    expect(isAffirmation('ja, und frag nach Freitag', 'de')).toBe(false);
    expect(isAffirmation('', 'en')).toBe(false);
  });

  it('treats text contained in what JARVIS says as its own echo', () => {
    expect(isEcho('the weather in Berlin', ['The weather in Berlin is sunny.'])).toBe(true);
    expect(isEcho('wait', ['The weather in Berlin is sunny.'])).toBe(false);
    expect(isEcho('  ', ['anything'])).toBe(true);
  });

  it('takes only complete sentences of a growing answer, the rest when final', () => {
    let buffer = 'Berlin is sunny today. It will';
    const first = takeSentences(buffer, 0, false, 'en-US');
    expect(first.sentences).toEqual(['Berlin is sunny today.']);
    buffer += ' rain tomorrow. Take an umbrella';
    const second = takeSentences(buffer, first.next, false, 'en-US');
    expect(second.sentences).toEqual(['It will rain tomorrow.']);
    const last = takeSentences(buffer, second.next, true, 'en-US');
    expect(last.sentences).toEqual(['Take an umbrella']);
    expect(last.next).toBe(buffer.length);
    // Arabic and German sentences.
    expect(takeSentences('الجو مشمس. غداً ممطر؟ نعم', 0, false, 'ar-SA').sentences).toEqual([
      'الجو مشمس.',
      'غداً ممطر؟',
    ]);
    expect(takeSentences('Es ist sonnig. Morgen', 0, false, 'de-DE').sentences).toEqual([
      'Es ist sonnig.',
    ]);
  });

  it('splits long sentences at commas, then between words', () => {
    const long = `${'a'.repeat(200)}, ${'b'.repeat(150)}, ${'c'.repeat(50)}`;
    const chunks = chunkForSpeech(long, 300);
    expect(chunks).toEqual(['a'.repeat(200) + ',', `${'b'.repeat(150)}, ${'c'.repeat(50)}`]);
    expect(chunks.every((c) => c.length <= 300)).toBe(true);
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    expect(chunkForSpeech(words, 100).every((c) => c.length <= 100)).toBe(true);
    expect(chunkForSpeech('short', 300)).toEqual(['short']);
  });
});

describe('browser adapters (pure parts)', () => {
  it('reports each final result once and the interim text', () => {
    const result = (text: string, isFinal: boolean) =>
      Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal });
    const event = (results: Array<ReturnType<typeof result>>) =>
      ({ resultIndex: 0, results }) as unknown as Parameters<typeof readResultEvent>[0];
    const a = readResultEvent(event([result('hello', false)]), 0);
    expect(a).toEqual({ finals: [], interim: 'hello', seenFinal: 0 });
    const b = readResultEvent(event([result('hello there', true), result(' how', false)]), 0);
    expect(b).toEqual({ finals: ['hello there'], interim: 'how', seenFinal: 1 });
    const c = readResultEvent(
      event([result('hello there', true), result(' how are you', true)]),
      1,
    );
    expect(c).toEqual({ finals: ['how are you'], interim: '', seenFinal: 2 });
  });

  it('offers the voices of a language, exact region first', () => {
    const v = (id: string, lang: string) => ({ id, name: id, lang, local: true, isDefault: false });
    const all = [v('a', 'en-GB'), v('b', 'de-DE'), v('c', 'en-US'), v('d', 'en_AU')];
    expect(voicesFor(all, 'en-US').map((x) => x.id)).toEqual(['c', 'a', 'd']);
    expect(voicesFor(all, 'ar-SA')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ controller */

const TASK_1 = '11111111-1111-4111-8111-111111111111';
const TASK_2 = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';

const COPY = {
  lang: 'en-US',
  approvalOnScreen: 'This needs your approval on screen.',
  busy: 'I’m still working on your last request.',
  idleWarning: 'Still there? Voice mode ends soon.',
};

class NetworkError extends Error {
  kind = 'network' as const;
}
class BusyError extends Error {
  kind = 'busy' as const;
}
class FatalError extends Error {
  kind = 'fatal' as const;
}

function view(id: string, status: TaskStatus, extra: Partial<TaskView> = {}): TaskView {
  return {
    id,
    status,
    conversationId: CONV,
    answer: null,
    answerLang: 'en-US',
    line: null,
    approvalId: null,
    ...extra,
  };
}

function setup(
  options: {
    mic?: 'granted' | 'denied' | 'no-mic' | 'error';
    submit?: (req: SubmitRequest, n: number) => Promise<{ id: string }>;
    recognizer?: FakeRecognizer;
    synth?: FakeSynth;
    language?: 'en' | 'de' | 'ar';
  } = {},
) {
  const recognizer = options.recognizer ?? new FakeRecognizer();
  const synth = options.synth ?? new FakeSynth();
  const requests: SubmitRequest[] = [];
  const drafts: string[] = [];
  const ended: ConversationEnd[] = [];
  let keys = 0;
  let n = 0;
  const lang = { en: 'en-US', de: 'de-DE', ar: 'ar-SA' }[options.language ?? 'en'];
  const deps: ConversationDeps = {
    recognizer,
    synthesizer: synth,
    acquireMic: async () => options.mic ?? 'granted',
    submit: async (req) => {
      requests.push(req);
      const index = n++;
      const res = options.submit
        ? await options.submit(req, index)
        : { id: index === 0 ? TASK_1 : TASK_2 };
      return { id: res.id, conversationId: CONV, status: 'QUEUED' };
    },
    classifyError: (e) =>
      e instanceof NetworkError ? 'network' : e instanceof BusyError ? 'busy' : 'fatal',
    newKey: () => `key-${++keys}`,
    copy: COPY,
    settings: {
      recognitionLang: lang,
      language: options.language ?? 'en',
      silenceMs: 1200,
      rate: 1.25,
      voiceFor: (l) => (l.startsWith('de') ? 'voice-anna' : null),
    },
    onDraft: (text) => drafts.push(text),
    onEnded: (end) => ended.push(end),
  };
  const c = new ConversationController(deps);
  return { c, recognizer, synth, requests, drafts, ended };
}

/** Lets pending promise callbacks run (submit is async). */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function started(options: Parameters<typeof setup>[0] = {}) {
  const s = setup(options);
  await s.c.start();
  return s;
}

/** Says `text` as one final result and waits out the end-of-utterance silence. */
async function say(s: Awaited<ReturnType<typeof started>>, text: string) {
  s.recognizer.live.hear([text]);
  vi.advanceTimersByTime(1200);
  await flush();
}

describe('conversation controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts listening once the microphone is allowed', async () => {
    const s = await started();
    expect(s.c.getSnapshot()).toMatchObject({ mic: 'on', turn: 'ready' });
    expect(s.recognizer.live.lang).toBe('en-US');
  });

  it('ends an utterance only after a final result and the configured silence', async () => {
    const s = await started();
    s.recognizer.live.hear([], 'what is the');
    expect(s.c.getSnapshot().interim).toBe('what is the');
    vi.advanceTimersByTime(5000);
    expect(s.requests).toHaveLength(0); // Interim text never ends an utterance.
    s.recognizer.live.hear(['what is the weather'], '');
    vi.advanceTimersByTime(1100);
    expect(s.requests).toHaveLength(0);
    // Speaking again within the pause continues the same utterance.
    s.recognizer.live.hear([], 'in');
    vi.advanceTimersByTime(1500);
    s.recognizer.live.hear(['in Berlin'], '');
    vi.advanceTimersByTime(1199);
    expect(s.requests).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await flush();
    expect(s.requests).toEqual([
      {
        text: 'what is the weather in Berlin',
        source: 'voice',
        language: 'en',
        idempotencyKey: 'key-1',
        conversationId: null,
      },
    ]);
    expect(s.c.getSnapshot()).toMatchObject({ turn: 'thinking', taskId: TASK_1 });
    expect(s.c.getSnapshot().captions[0]).toMatchObject({
      speaker: 'user',
      text: 'what is the weather in Berlin',
      taskId: TASK_1,
      unsent: false,
    });
  });

  it('speaks the streamed answer sentence by sentence, then listens again', async () => {
    const s = await started();
    await say(s, 'what is the weather in Berlin');
    s.c.answerDelta(TASK_1, 'It is sunny in Berlin');
    expect(s.synth.texts).toEqual([]); // Not a complete sentence yet.
    s.c.answerDelta(TASK_1, ' today. Tomorrow it');
    // The first sentence is spoken while the answer is still being written.
    expect(s.synth.texts).toEqual(['It is sunny in Berlin today.']);
    expect(s.synth.spoken[0]).toMatchObject({ lang: 'en-US', rate: 1.25, voiceId: null });
    expect(s.c.getSnapshot().turn).toBe('speaking');
    s.c.answerDelta(TASK_1, ' will rain.');
    s.synth.finish();
    expect(s.c.getSnapshot().turn).toBe('thinking'); // Task still running, answer not final.
    s.c.updateTask(
      view(TASK_1, 'COMPLETED', {
        answer: 'It is sunny in Berlin today. Tomorrow it will rain.',
      }),
    );
    expect(s.synth.speaking).toBe('Tomorrow it will rain.');
    s.synth.finish();
    expect(s.c.getSnapshot().turn).toBe('ready');
    expect(s.synth.texts).toEqual(['It is sunny in Berlin today.', 'Tomorrow it will rain.']);
    // One caption for the whole reply.
    const jarvis = s.c.getSnapshot().captions.filter((c) => c.speaker === 'jarvis');
    expect(jarvis).toHaveLength(1);
    expect(jarvis[0]!.text).toBe('It is sunny in Berlin today. Tomorrow it will rain.');
  });

  it('sends the next utterance as a follow-up in the same conversation', async () => {
    const s = await started();
    await say(s, 'remember that I like tea');
    s.c.updateTask(
      view(TASK_1, 'COMPLETED', { line: { text: 'Saved.', lang: 'en-US', kind: 'result' } }),
    );
    s.synth.finish();
    await say(s, 'and email it to me');
    expect(s.requests[1]).toMatchObject({
      text: 'and email it to me',
      conversationId: CONV,
      idempotencyKey: 'key-2',
    });
    expect(s.c.getSnapshot().counters).toMatchObject({ turns: 2 });
  });

  it('speaks the result line, a question or the error when there is no answer', async () => {
    const s = await started();
    await say(s, 'email me the summary');
    s.c.updateTask(
      view(TASK_1, 'COMPLETED', {
        line: { text: 'Which address should I use?', lang: 'en-US', kind: 'question' },
      }),
    );
    expect(s.synth.speaking).toBe('Which address should I use?');
    s.synth.finish();
    expect(s.c.getSnapshot().turn).toBe('ready');
    // The same terminal state arriving again (a refetch) is not spoken twice.
    s.c.updateTask(
      view(TASK_1, 'COMPLETED', {
        line: { text: 'Which address should I use?', lang: 'en-US', kind: 'question' },
      }),
    );
    expect(s.synth.texts).toHaveLength(1);
  });

  it('barge-in: the user speaking stops JARVIS at once and takes the turn', async () => {
    const s = await started();
    await say(s, 'tell me about Berlin');
    s.c.answerDelta(TASK_1, 'Berlin is the capital of Germany. It has many museums. ');
    expect(s.synth.speaking).toBe('Berlin is the capital of Germany.');
    // Its own voice picked up by the microphone is not an interruption.
    s.recognizer.live.hear([], 'Berlin is the capital');
    expect(s.c.getSnapshot().turn).toBe('speaking');
    expect(s.synth.cancels).toBe(0);
    // The user says something else.
    s.recognizer.live.hear([], 'wait');
    expect(s.synth.cancels).toBe(1);
    expect(s.synth.speaking).toBeNull();
    const snap = s.c.getSnapshot();
    expect(snap.turn).toBe('ready');
    expect(snap.counters.bargeIns).toBe(1);
    expect(snap.captions.find((c) => c.speaker === 'jarvis')).toMatchObject({ interrupted: true });
    // The rest of the interrupted answer is not spoken.
    s.c.answerDelta(TASK_1, 'More text follows here. ');
    s.c.updateTask(view(TASK_1, 'COMPLETED', { answer: 'Berlin… full answer.' }));
    expect(s.synth.texts).toEqual(['Berlin is the capital of Germany.']);
  });

  it('interrupting the approval notice does not silence the result after the approval', async () => {
    const s = await started();
    await say(s, 'call +49 30 1234567 and ask about Friday');
    s.c.updateTask(view(TASK_1, 'AWAITING_APPROVAL', { approvalId: 'a' }));
    expect(s.synth.speaking).toBe(COPY.approvalOnScreen);
    s.recognizer.live.hear([], 'okay');
    expect(s.synth.speaking).toBeNull();
    expect(s.c.getSnapshot().turn).toBe('awaiting_approval');
    s.c.updateTask(view(TASK_1, 'RUNNING'));
    s.c.updateTask(
      view(TASK_1, 'COMPLETED', {
        line: { text: 'They have 9:30 free.', lang: 'en-US', kind: 'result' },
      }),
    );
    expect(s.synth.speaking).toBe('They have 9:30 free.');
  });

  it('typing while JARVIS speaks also interrupts it', async () => {
    const s = await started();
    await say(s, 'tell me a story');
    s.c.updateTask(view(TASK_1, 'COMPLETED', { answer: 'Once upon a time. There was a fox.' }));
    expect(s.synth.speaking).toBe('Once upon a time.');
    expect(s.c.submitText('shorter please')).toBe(true);
    await flush();
    expect(s.synth.cancels).toBe(1);
    expect(s.requests[1]).toMatchObject({ text: 'shorter please', source: 'text' });
  });

  it('never takes an approval by voice: says so, keeps other words for the text field', async () => {
    const s = await started();
    await say(s, 'call my dentist on +49 30 1234567');
    s.c.updateTask(view(TASK_1, 'AWAITING_APPROVAL', { approvalId: 'appr-1' }));
    expect(s.synth.speaking).toBe(COPY.approvalOnScreen);
    s.synth.finish();
    expect(s.c.getSnapshot()).toMatchObject({ turn: 'awaiting_approval', approvalId: 'appr-1' });
    // "yes" is not a decision and not a request.
    await say(s, 'Yes.');
    expect(s.requests).toHaveLength(1);
    expect(s.drafts).toEqual([]);
    expect(s.synth.speaking).toBe(COPY.approvalOnScreen);
    s.synth.finish();
    // Anything else waits in the text field.
    await say(s, 'also ask about Friday');
    expect(s.requests).toHaveLength(1);
    expect(s.drafts).toEqual(['also ask about Friday']);
    s.synth.finish();
    // The same approval arriving again is announced only once.
    s.c.updateTask(view(TASK_1, 'AWAITING_APPROVAL', { approvalId: 'appr-1' }));
    expect(s.synth.texts.filter((t) => t === COPY.approvalOnScreen)).toHaveLength(3);
    // Approved on screen → thinking.
    s.c.updateTask(view(TASK_1, 'RUNNING'));
    expect(s.c.getSnapshot().turn).toBe('thinking');
  });

  it('does not send while the previous request still runs; says so and keeps the text', async () => {
    const s = await started();
    await say(s, 'summarize this page');
    s.c.updateTask(view(TASK_1, 'RUNNING'));
    await say(s, 'and translate it');
    expect(s.requests).toHaveLength(1);
    expect(s.drafts).toEqual(['and translate it']);
    expect(s.synth.speaking).toBe(COPY.busy);
    expect(s.c.getSnapshot().captions.at(-2)).toMatchObject({ unsent: true });
  });

  it('a server CONVERSATION_BUSY is handled the same way', async () => {
    const s = await started({
      submit: async () => {
        throw new BusyError('busy');
      },
    });
    await say(s, 'hello');
    expect(s.drafts).toEqual(['hello']);
    expect(s.synth.speaking).toBe(COPY.busy);
    expect(s.c.getSnapshot().captions[0]).toMatchObject({ unsent: true });
  });

  it('a stop phrase ends voice mode in each language — never sent, never cancelling', async () => {
    for (const [language, phrase] of [
      ['en', 'Stop.'],
      ['de', 'Stopp!'],
      ['ar', 'توقف'],
    ] as const) {
      const s = await started({ language });
      await say(s, phrase);
      expect(s.requests, phrase).toHaveLength(0);
      expect(s.c.getSnapshot()).toMatchObject({ turn: 'ended', endReason: 'voice_command' });
      expect(s.ended).toHaveLength(1);
      expect(s.recognizer.isListening).toBe(false);
    }
    // Also while a task waits for approval (the task keeps waiting).
    const s = await started();
    await say(s, 'call +49 30 1234567');
    s.c.updateTask(view(TASK_1, 'AWAITING_APPROVAL', { approvalId: 'a' }));
    s.synth.finish();
    await say(s, 'stop listening');
    expect(s.c.getSnapshot().endReason).toBe('voice_command');
    expect(s.requests).toHaveLength(1);
  });

  it('retries a failed submit with the same Idempotency-Key and backoff', async () => {
    const s = await started({
      submit: async (_req, n) => {
        if (n < 2) throw new NetworkError('offline');
        return { id: TASK_1 };
      },
    });
    await say(s, 'what time is it');
    expect(s.c.getSnapshot().turn).toBe('retrying');
    vi.advanceTimersByTime(VOICE_LIMITS.reconnectDelaysMs[0]!);
    await flush();
    expect(s.c.getSnapshot().turn).toBe('retrying');
    vi.advanceTimersByTime(VOICE_LIMITS.reconnectDelaysMs[1]!);
    await flush();
    expect(s.requests.map((r) => r.idempotencyKey)).toEqual(['key-1', 'key-1', 'key-1']);
    expect(s.c.getSnapshot()).toMatchObject({ turn: 'thinking', taskId: TASK_1 });
    expect(s.c.getSnapshot().counters).toMatchObject({ reconnects: 2, turns: 1 });
  });

  it('after the last retry, listening ends with the error and the text in the field', async () => {
    const s = await started({
      submit: async () => {
        throw new NetworkError('offline');
      },
    });
    await say(s, 'remind me tomorrow');
    for (const delay of VOICE_LIMITS.reconnectDelaysMs) {
      vi.advanceTimersByTime(delay);
      await flush();
    }
    expect(s.requests).toHaveLength(VOICE_LIMITS.reconnectDelaysMs.length + 1);
    expect(s.c.getSnapshot()).toMatchObject({ turn: 'failed', mic: 'off' });
    expect(s.c.getSnapshot().error?.source).toBe('submit');
    expect(s.drafts).toEqual(['remind me tomorrow']);
    expect(s.recognizer.isListening).toBe(false);
    // "Listen again" recovers.
    await s.c.resume();
    expect(s.c.getSnapshot()).toMatchObject({ turn: 'ready', mic: 'on', error: null });
  });

  it('a refused request (validation) is shown and kept, the conversation goes on', async () => {
    const s = await started({
      submit: async () => {
        throw new FatalError('bad');
      },
    });
    await say(s, 'x');
    expect(s.c.getSnapshot()).toMatchObject({ turn: 'ready', mic: 'on' });
    expect(s.c.getSnapshot().error?.source).toBe('submit');
    expect(s.drafts).toEqual(['x']);
  });

  it('restarts recognition after network errors with backoff, then gives up', async () => {
    const s = await started();
    s.recognizer.live.error('network');
    expect(s.c.getSnapshot().mic).toBe('starting');
    expect(s.recognizer.isListening).toBe(false);
    vi.advanceTimersByTime(VOICE_LIMITS.reconnectDelaysMs[0]!);
    expect(s.c.getSnapshot().mic).toBe('on');
    expect(s.recognizer.runs).toHaveLength(2);
    for (const delay of VOICE_LIMITS.reconnectDelaysMs.slice(1)) {
      s.recognizer.live.error('network');
      vi.advanceTimersByTime(delay);
    }
    s.recognizer.live.error('network');
    expect(s.c.getSnapshot().mic).toBe('error');
    expect(s.c.getSnapshot().error?.source).toBe('recognition');
    expect(s.c.getSnapshot().counters.reconnects).toBe(VOICE_LIMITS.reconnectDelaysMs.length);
  });

  it('restarts at once when continuous recognition ends by itself', async () => {
    const s = await started();
    s.recognizer.live.end();
    expect(s.recognizer.runs).toHaveLength(2);
    expect(s.c.getSnapshot().mic).toBe('on');
  });

  it('explains a blocked or missing microphone', async () => {
    expect((await started({ mic: 'denied' })).c.getSnapshot().mic).toBe('denied');
    expect((await started({ mic: 'no-mic' })).c.getSnapshot().mic).toBe('no-mic');
    const s = await started();
    s.recognizer.live.error('not-allowed');
    expect(s.c.getSnapshot().mic).toBe('denied');
  });

  it('without recognition it is a typed conversation with spoken replies', async () => {
    const recognizer = new FakeRecognizer();
    recognizer.supported = false;
    const s = await started({ recognizer });
    expect(s.c.getSnapshot().mic).toBe('unsupported');
    s.c.submitText('what is new');
    await flush();
    expect(s.requests[0]).toMatchObject({ source: 'text', text: 'what is new' });
    s.c.updateTask(view(TASK_1, 'COMPLETED', { answer: 'Nothing much.' }));
    expect(s.synth.speaking).toBe('Nothing much.');
  });

  it('without speech output it shows captions and returns to listening', async () => {
    const synth = new FakeSynth();
    synth.supported = false;
    const s = await started({ synth });
    await say(s, 'hi');
    s.c.updateTask(view(TASK_1, 'COMPLETED', { answer: 'Hello. How can I help?' }));
    expect(s.c.getSnapshot().turn).toBe('ready');
    expect(s.c.getSnapshot().captions.at(-1)).toMatchObject({
      speaker: 'jarvis',
      text: 'Hello. How can I help?',
    });
  });

  it('speaks German answers with the German voice', async () => {
    const s = await started({ language: 'de' });
    await say(s, 'wie ist das Wetter');
    s.c.updateTask(view(TASK_1, 'COMPLETED', { answer: 'Es ist sonnig.', answerLang: 'de-DE' }));
    expect(s.synth.spoken[0]).toMatchObject({ lang: 'de-DE', voiceId: 'voice-anna' });
  });

  it('speaks a streamed answer in the language the server detected for the request', async () => {
    // Recognition ran in English, but the request was German (TaskDetail.language 'de').
    const s = await started();
    await say(s, 'wie ist das Wetter');
    s.c.updateTask(view(TASK_1, 'RUNNING', { answerLang: 'de-DE' }));
    s.c.answerDelta(TASK_1, 'Es ist sonnig. Morgen');
    expect(s.synth.spoken[0]).toMatchObject({ text: 'Es ist sonnig.', lang: 'de-DE' });
  });

  it('announces the idle end, then ends; speaking resets it', async () => {
    const s = await started();
    vi.advanceTimersByTime(VOICE_LIMITS.idleEndSeconds * 1000 - 20_000);
    s.recognizer.live.hear([], 'hmm');
    s.recognizer.live.hear(['hmm'], '');
    // Ended the utterance "hmm" … it is a request; answer it to get back to ready.
    vi.advanceTimersByTime(1200);
    await flush();
    s.c.updateTask(
      view(TASK_1, 'COMPLETED', { line: { text: 'OK.', lang: 'en-US', kind: 'result' } }),
    );
    s.synth.finish();
    expect(s.c.getSnapshot().turn).toBe('ready');
    vi.advanceTimersByTime(VOICE_LIMITS.idleEndSeconds * 1000 - 10_000);
    expect(s.c.getSnapshot().notice).toBe('idleWarning');
    expect(s.synth.speaking).toBe(COPY.idleWarning);
    s.synth.finish();
    vi.advanceTimersByTime(10_000);
    expect(s.c.getSnapshot()).toMatchObject({ turn: 'ended', endReason: 'idle' });
    expect(s.ended[0]).toMatchObject({ reason: 'idle', counters: { turns: 1 } });
  });

  it('does not end while JARVIS is working on a request', async () => {
    const s = await started();
    await say(s, 'call +49 30 1234567 and ask about Friday');
    s.c.updateTask(view(TASK_1, 'RUNNING'));
    vi.advanceTimersByTime(VOICE_LIMITS.idleEndSeconds * 1000 * 3);
    expect(s.c.getSnapshot().turn).toBe('thinking');
  });

  it('pausing stops recognition (and sends words already heard); resuming listens again', async () => {
    const s = await started();
    s.recognizer.live.hear(['open my tasks'], '');
    s.c.toggleMic();
    await flush();
    expect(s.c.getSnapshot().mic).toBe('muted');
    expect(s.recognizer.isListening).toBe(false);
    expect(s.requests[0]).toMatchObject({ text: 'open my tasks' });
    s.c.toggleMic();
    await flush();
    expect(s.c.getSnapshot().mic).toBe('on');
    expect(s.recognizer.isListening).toBe(true);
  });

  it('changing the language restarts recognition in it', async () => {
    const s = await started();
    s.c.updateSettings({ recognitionLang: 'ar-SA', language: 'ar' });
    expect(s.recognizer.runs[0]!.aborted).toBe(true);
    expect(s.recognizer.live.lang).toBe('ar-SA');
  });

  it('ending reports metadata only and stops everything', async () => {
    const s = await started();
    await say(s, 'hello there');
    s.c.updateTask(view(TASK_1, 'COMPLETED', { answer: 'Hi! How can I help you today?' }));
    s.recognizer.live.hear([], 'no thanks');
    s.c.end('end_button');
    expect(s.ended).toEqual([
      {
        reason: 'end_button',
        counters: { turns: 1, bargeIns: 1, reconnects: 0, chars: 'hello there'.length },
        errorCode: null,
      },
    ]);
    expect(s.recognizer.isListening).toBe(false);
    expect(s.synth.speaking).toBeNull();
    // Nothing happens after the end.
    s.c.end('escape_key');
    expect(s.ended).toHaveLength(1);
  });
});
