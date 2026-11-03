/**
 * Browser speech APIs: dictation via the Web Speech API (SpeechRecognition, prefixed in Chrome
 * and Safari) and read-aloud via speechSynthesis. Audio never reaches JARVIS; recognition runs
 * in the browser's speech service.
 */

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: { readonly transcript: string; readonly confidence: number };
}

export interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: SpeechRecognitionResultLike };
}

export interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
  readonly message: string;
}

export interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

export function getSpeechRecognition(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Dictation needs both speech recognition and microphone access (for the level meter). */
export function isVoiceInputSupported(): boolean {
  return (
    getSpeechRecognition() !== null &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    window.isSecureContext
  );
}

/** Splits recognition results into the final text and the still-changing interim text. */
export function readResults(event: SpeechRecognitionEventLike): { final: string; interim: string } {
  let final = '';
  let interim = '';
  for (let i = 0; i < event.results.length; i++) {
    const result = event.results[i];
    const text = result?.[0]?.transcript ?? '';
    if (result?.isFinal) final += text;
    else interim += text;
  }
  return { final, interim };
}

/** Joins transcript pieces with single spaces. */
export function joinTranscript(...parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ');
}

export function canSpeak(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * Reads text aloud with the browser's speech synthesis in the given language (e.g. 'de-DE').
 * Cancels anything still being spoken. Returns false when synthesis is unavailable.
 */
export function speak(text: string, lang: string): boolean {
  if (!canSpeak() || !text.trim()) return false;
  const synth = window.speechSynthesis;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  const prefix = lang.slice(0, 2).toLowerCase();
  const voice =
    synth.getVoices().find((v) => v.lang.toLowerCase() === lang.toLowerCase()) ??
    synth.getVoices().find((v) => v.lang.toLowerCase().startsWith(prefix));
  if (voice) utterance.voice = voice;
  synth.speak(utterance);
  return true;
}

export function stopSpeaking(): void {
  if (canSpeak()) window.speechSynthesis.cancel();
}
