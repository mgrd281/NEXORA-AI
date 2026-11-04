/**
 * The Web Speech API behind the speech seams of ./types: continuous SpeechRecognition with
 * interim results (prefixed in Chrome and Safari) and speechSynthesis with the device's voices.
 * Honest about support: `supported` is false where the browser has no recogniser (Firefox) or
 * no synthesis, and the conversation then offers typing / captions instead.
 */
import {
  getSpeechRecognition,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
} from '../speech';
import type {
  MicResult,
  RecognitionErrorCode,
  RecognitionHandlers,
  RecognitionRun,
  SpeakHandlers,
  SpeakOptions,
  SpeechRecognizer,
  SpeechSynthesizer,
  SynthVoice,
} from './types';

const ERROR_CODES: ReadonlySet<string> = new Set<RecognitionErrorCode>([
  'no-speech',
  'aborted',
  'audio-capture',
  'network',
  'not-allowed',
  'service-not-allowed',
  'language-not-supported',
  'bad-grammar',
]);

/**
 * Reads one result event: the results that became final since the last event (they never change
 * again) and the interim text. Final results precede interim ones in every engine we support.
 */
export function readResultEvent(
  event: SpeechRecognitionEventLike,
  seenFinal: number,
): { finals: string[]; interim: string; seenFinal: number } {
  const finals: string[] = [];
  let interim = '';
  let finalCount = 0;
  for (let i = 0; i < event.results.length; i++) {
    const result = event.results[i];
    const text = result?.[0]?.transcript ?? '';
    if (result?.isFinal) {
      finalCount = i + 1;
      if (i >= seenFinal && text.trim()) finals.push(text.trim());
    } else {
      interim += text;
    }
  }
  return { finals, interim: interim.trim(), seenFinal: Math.max(seenFinal, finalCount) };
}

export function createBrowserRecognizer(): SpeechRecognizer {
  const Ctor = getSpeechRecognition();
  return {
    supported: Ctor !== null && typeof window !== 'undefined' && window.isSecureContext,
    start(lang: string, handlers: RecognitionHandlers): RecognitionRun {
      if (!Ctor) throw new Error('Speech recognition is not supported');
      const rec: SpeechRecognitionLike = new Ctor();
      rec.lang = lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      let seenFinal = 0;
      rec.onstart = () => handlers.onStart?.();
      rec.onresult = (event) => {
        const read = readResultEvent(event, seenFinal);
        seenFinal = read.seenFinal;
        handlers.onResult(read.finals, read.interim);
      };
      rec.onerror = (event) => {
        handlers.onError(
          ERROR_CODES.has(event.error) ? (event.error as RecognitionErrorCode) : 'unknown',
        );
      };
      rec.onend = () => handlers.onEnd();
      rec.start();
      return {
        stop: () => rec.stop(),
        abort: () => rec.abort(),
      };
    },
  };
}

function toVoice(v: SpeechSynthesisVoice): SynthVoice {
  return {
    id: v.voiceURI,
    name: v.name,
    lang: v.lang,
    local: v.localService,
    isDefault: v.default,
  };
}

/** The device's voices for a language: an exact match first, then the same language. */
export function voicesFor(voices: readonly SynthVoice[], lang: string): SynthVoice[] {
  const tag = lang.toLowerCase().replace('_', '-');
  const prefix = tag.slice(0, 2);
  const norm = (v: SynthVoice) => v.lang.toLowerCase().replace('_', '-');
  return [
    ...voices.filter((v) => norm(v) === tag),
    ...voices.filter((v) => norm(v) !== tag && norm(v).slice(0, 2) === prefix),
  ];
}

export function createBrowserSynthesizer(): SpeechSynthesizer {
  const synth =
    typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
  const Utterance =
    typeof window !== 'undefined' && 'SpeechSynthesisUtterance' in window
      ? window.SpeechSynthesisUtterance
      : null;
  // Chrome drops the end event of utterances that were garbage-collected: keep them referenced.
  const live = new Set<SpeechSynthesisUtterance>();
  let generation = 0;
  return {
    supported: synth !== null && Utterance !== null,
    voices: () => (synth ? synth.getVoices().map(toVoice) : []),
    onVoicesChanged(listener) {
      if (!synth || typeof synth.addEventListener !== 'function') return () => undefined;
      synth.addEventListener('voiceschanged', listener);
      return () => synth.removeEventListener('voiceschanged', listener);
    },
    speak(text: string, options: SpeakOptions, handlers: SpeakHandlers) {
      if (!synth || !Utterance) {
        handlers.onError('unsupported');
        return;
      }
      const gen = generation;
      const u = new Utterance(text);
      u.lang = options.lang;
      u.rate = options.rate;
      const all = synth.getVoices();
      const chosen =
        (options.voiceId ? all.find((v) => v.voiceURI === options.voiceId) : undefined) ??
        all.find((v) => v.lang.toLowerCase() === options.lang.toLowerCase() && v.default) ??
        all.find((v) => v.lang.toLowerCase() === options.lang.toLowerCase()) ??
        all.find(
          (v) => v.lang.slice(0, 2).toLowerCase() === options.lang.slice(0, 2).toLowerCase(),
        );
      if (chosen) u.voice = chosen;
      live.add(u);
      u.onstart = () => {
        if (gen === generation) handlers.onStart?.();
      };
      u.onend = () => {
        live.delete(u);
        if (gen === generation) handlers.onEnd();
      };
      u.onerror = (event) => {
        live.delete(u);
        // A cancelled utterance reports 'interrupted' / 'canceled': not an error of ours.
        if (gen === generation) handlers.onError(event.error ?? 'unknown');
      };
      synth.speak(u);
    },
    cancel() {
      generation++;
      live.clear();
      synth?.cancel();
    },
  };
}

/**
 * The microphone for voice input: one getUserMedia stream with echo cancellation (the level
 * meter reads it; recognition itself captures through the browser's speech service).
 */
export async function requestMicrophone(): Promise<{
  result: MicResult;
  stream: MediaStream | null;
}> {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.mediaDevices?.getUserMedia !== 'function'
  )
    return { result: 'error', stream: null };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return { result: 'granted', stream };
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError')
      return { result: 'denied', stream: null };
    if (name === 'NotFoundError' || name === 'OverconstrainedError')
      return { result: 'no-mic', stream: null };
    return { result: 'error', stream: null };
  }
}
