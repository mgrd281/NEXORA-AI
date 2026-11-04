/**
 * Text rules of voice conversation mode (pure, unit-tested): utterance normalisation, the spoken
 * stop phrases of contracts VOICE_LIMITS, affirmations that are never approvals, the echo guard
 * for barge-in, and sentence-by-sentence chunking of a streamed answer.
 */
import type { Locale } from '@jarvis/contracts';
import { VOICE_LIMITS } from '@jarvis/contracts';

/**
 * Lower-case, without punctuation, symbols or diacritics, single spaces: "Stopp!" → "stopp",
 * "أنهِ المحادثة." → "انه المحادثه", "Aufhören" → "aufhoren". Both sides of every comparison go
 * through this, so recognisers that add or drop marks still match.
 */
export function normalizeUtterance(text: string): string {
  return (
    text
      .normalize('NFKD')
      // Combining marks: Latin accents, Arabic harakat, hamza above / below.
      .replace(/\p{M}/gu, '')
      // Arabic tatweel; alef maqsura and teh marbuta read as yeh and heh.
      .replace(/ـ/g, '')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/ٱ/g, 'ا')
      .toLowerCase()
      .replace(/[\p{P}\p{S}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

const STOP = Object.fromEntries(
  (Object.keys(VOICE_LIMITS.stopPhrases) as Locale[]).map((locale) => [
    locale,
    new Set(VOICE_LIMITS.stopPhrases[locale].map(normalizeUtterance)),
  ]),
) as Record<Locale, Set<string>>;

/**
 * A whole utterance that ends voice mode ("stop", "stopp", "توقف" …) in the recognition
 * language: compared lower-cased without punctuation. Never sent as a request.
 */
export function isStopPhrase(text: string, locale: Locale): boolean {
  const normalized = normalizeUtterance(text);
  return normalized !== '' && STOP[locale].has(normalized);
}

/**
 * Spoken assent ("yes", "approve it", "ja, genehmigen", "نعم موافق"): an utterance made only of
 * assent words. Approvals are never given by voice (ADR-0019): while one waits, these are
 * answered with "confirm it on screen" and not kept as a request.
 */
const ASSENT_WORDS: Record<Locale, readonly string[]> = {
  en: [
    'yes',
    'yeah',
    'yep',
    'ok',
    'okay',
    'sure',
    'fine',
    'right',
    'correct',
    'please',
    'approve',
    'approved',
    'confirm',
    'confirmed',
    'go',
    'ahead',
    'do',
    'it',
    'i',
    'that',
    'this',
    'call',
  ],
  de: [
    'ja',
    'jawohl',
    'genau',
    'ok',
    'okay',
    'klar',
    'gut',
    'richtig',
    'bitte',
    'genehmigen',
    'genehmigt',
    'genehmige',
    'ich',
    'bestätigen',
    'bestätigt',
    'bestätige',
    'einverstanden',
    'freigeben',
    'mach',
    'das',
    'es',
    'los',
    'anrufen',
  ],
  ar: [
    'نعم',
    'أجل',
    'أيوه',
    'موافق',
    'أوافق',
    'وافق',
    'حسنا',
    'حسناً',
    'تمام',
    'أكد',
    'أؤكد',
    'تأكيد',
    'نفذ',
    'نفّذ',
    'اتصل',
    'من',
    'فضلك',
    'بالتأكيد',
  ],
};
const ASSENT = Object.fromEntries(
  (Object.keys(ASSENT_WORDS) as Locale[]).map((locale) => [
    locale,
    new Set(ASSENT_WORDS[locale].map(normalizeUtterance)),
  ]),
) as Record<Locale, Set<string>>;

export function isAffirmation(text: string, locale: Locale): boolean {
  const words = normalizeUtterance(text).split(' ').filter(Boolean);
  return words.length > 0 && words.every((w) => ASSENT[locale].has(w));
}

/**
 * The echo guard: recognised text that is contained in what JARVIS is (or just was) saying is
 * its own voice picked up by the microphone, not the user — it neither interrupts nor becomes a
 * request.
 */
export function isEcho(heard: string, spoken: readonly string[]): boolean {
  const h = normalizeUtterance(heard);
  if (!h) return true;
  return spoken.some((s) => normalizeUtterance(s).includes(h));
}

/* ------------------------------------------------------------------ sentences */

type Segmenter = { segment(text: string): Iterable<{ segment: string; index: number }> };

const segmenters = new Map<string, Segmenter | null>();

function segmenterFor(lang: string): Segmenter | null {
  if (!segmenters.has(lang)) {
    const Ctor = (Intl as unknown as { Segmenter?: new (l: string, o: object) => Segmenter })
      .Segmenter;
    segmenters.set(lang, Ctor ? new Ctor(lang, { granularity: 'sentence' }) : null);
  }
  return segmenters.get(lang) ?? null;
}

/** Sentences of `text` (with their trailing spaces), in order; Intl.Segmenter where available. */
export function splitSentences(text: string, lang: string): string[] {
  if (!text) return [];
  const seg = segmenterFor(lang);
  if (seg) return [...seg.segment(text)].map((s) => s.segment);
  // Fallback: end at . ! ? … ؟ (and line breaks) followed by space.
  return text.match(/[^.!?…؟\n]*(?:[.!?…؟]+|\n+|$)\s*/gu)?.filter((s) => s !== '') ?? [text];
}

/**
 * The sentences of a growing answer that are complete: every sentence but the last (it may still
 * grow) unless `final`. `from` is how much of `buffer` was taken already; returns the new
 * sentences (trimmed, non-empty) and the new `from`.
 */
export function takeSentences(
  buffer: string,
  from: number,
  final: boolean,
  lang: string,
): { sentences: string[]; next: number } {
  const rest = buffer.slice(from);
  const parts = splitSentences(rest, lang);
  const complete = final ? parts : parts.slice(0, -1);
  let next = from;
  const sentences: string[] = [];
  for (const part of complete) {
    next += part.length;
    const trimmed = part.trim();
    if (trimmed) sentences.push(trimmed);
  }
  return { sentences, next };
}

/**
 * Splits one sentence into spoken chunks of at most `max` characters: at commas first (also the
 * Arabic comma and semicolons), then between words, then hard.
 */
export function chunkForSpeech(
  sentence: string,
  max: number = VOICE_LIMITS.maxSpokenChunkChars,
): string[] {
  const text = sentence.trim();
  if (text.length <= max) return text ? [text] : [];
  const out: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) out.push(current.trim());
    current = '';
  };
  for (const clause of text.split(/(?<=[,،;؛])\s+/u)) {
    if ((current ? current.length + 1 : 0) + clause.length <= max) {
      current = current ? `${current} ${clause}` : clause;
      continue;
    }
    push();
    if (clause.length <= max) {
      current = clause;
      continue;
    }
    for (const word of clause.split(/\s+/)) {
      if ((current ? current.length + 1 : 0) + word.length <= max) {
        current = current ? `${current} ${word}` : word;
        continue;
      }
      push();
      let w = word;
      while (w.length > max) {
        out.push(w.slice(0, max));
        w = w.slice(max);
      }
      current = w;
    }
  }
  push();
  return out;
}
