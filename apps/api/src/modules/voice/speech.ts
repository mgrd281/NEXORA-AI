/**
 * Natural voice: JARVIS's replies read aloud by a neural text-to-speech model (OpenAI
 * gpt-4o-mini-tts by default). Only the reply text is sent; audio never leaves the device
 * in the other direction (recognition stays on the phone / in the browser).
 *
 * Gates (in this order): a key is configured, the user allows external models, and the
 * monthly AI budget has room. The estimated cost is recorded as model spend, so it counts
 * toward the same budget as Claude.
 */
import type { Locale } from '@jarvis/contracts';
import type { Config } from '../../config';
import { AppError } from '../../lib/errors';

export type SpeechConfig = Pick<Config, 'OPENAI_API_KEY' | 'OPENAI_TTS_MODEL' | 'OPENAI_TTS_VOICE'>;

export function speechConfigured(config: Pick<Config, 'OPENAI_API_KEY'>): boolean {
  return !!config.OPENAI_API_KEY && config.OPENAI_API_KEY.trim().length > 0;
}

/**
 * Estimated price of synthesized speech in micro-USD: gpt-4o-mini-tts costs about
 * $0.015 per minute of audio, and a minute of calm speech is roughly 900 characters.
 */
export const SPEECH_MICRO_PER_CHAR = 17;
export const speechCostMicro = (chars: number): number => Math.ceil(chars * SPEECH_MICRO_PER_CHAR);

/** How JARVIS should sound, per language (style only; the words are the reply's). */
const INSTRUCTIONS: Record<Locale, string> = {
  en: 'You are JARVIS, a calm, capable personal assistant. Speak natural, warm, clear English at a normal pace, like a real conversation. Read numbers, dates and amounts correctly. No announcer tone, no exaggeration.',
  de: 'Du bist JARVIS, ein ruhiger, kompetenter persönlicher Assistent. Sprich natürliches, warmes, klares Hochdeutsch in normalem Tempo, wie in einem echten Gespräch. Zahlen, Daten und Beträge korrekt aussprechen. Kein Vorlese-Ton, keine Übertreibung.',
  ar: 'أنت JARVIS، مساعد شخصي هادئ وكفء. تكلّم بعربية فصحى مبسّطة وواضحة ودافئة، بسرعة معتدلة كما في حديث حقيقي. انطق الأرقام والتواريخ والمبالغ بشكل صحيح. بدون نبرة قراءة آلية وبدون مبالغة.',
};

export interface SpeechResult {
  audio: Buffer;
  mediaType: 'audio/mpeg';
  model: string;
}

/** Calls the provider. Errors are user-safe AppErrors (the provider's message is not shown). */
export async function synthesizeSpeech(
  config: SpeechConfig,
  input: { text: string; language: Locale },
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<SpeechResult> {
  if (!speechConfigured(config))
    throw new AppError('SERVICE_UNAVAILABLE', 'The natural voice is not set up on this server.');
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.OPENAI_API_KEY!.trim()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.OPENAI_TTS_MODEL,
        voice: config.OPENAI_TTS_VOICE,
        input: input.text.replace(/\s+/g, ' ').trim(),
        instructions: INSTRUCTIONS[input.language],
        response_format: 'mp3',
      }),
      signal: opts.signal ?? AbortSignal.timeout(30_000),
    });
  } catch {
    throw new AppError('SERVICE_UNAVAILABLE', 'The natural voice could not be reached.');
  }
  if (!res.ok) {
    // 401/403/429 (key, quota) are account problems; the apps fall back to the device voice.
    throw new AppError('SERVICE_UNAVAILABLE', `The natural voice is unavailable (${res.status}).`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length === 0)
    throw new AppError('SERVICE_UNAVAILABLE', 'The natural voice returned no audio.');
  return { audio, mediaType: 'audio/mpeg', model: config.OPENAI_TTS_MODEL };
}
