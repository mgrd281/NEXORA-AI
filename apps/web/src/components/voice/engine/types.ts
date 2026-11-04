/**
 * The speech seams of voice conversation mode (docs/architecture/phase-d.md §3.1, ADR-0019).
 * The conversation controller only talks to these interfaces; `browser.ts` implements them on
 * the Web Speech API, and the tests drive them with deterministic fakes (test/ and e2e/support
 * only). Audio never leaves the device through JARVIS.
 */

/** Web Speech recognition error codes (SpeechRecognitionErrorEvent.error), plus 'unknown'. */
export type RecognitionErrorCode =
  | 'no-speech'
  | 'aborted'
  | 'audio-capture'
  | 'network'
  | 'not-allowed'
  | 'service-not-allowed'
  | 'language-not-supported'
  | 'bad-grammar'
  | 'unknown';

export interface RecognitionHandlers {
  /** The recogniser is capturing. */
  onStart?(): void;
  /**
   * Recognition progress of this run: segments that became final since the last call (in
   * order) and the current, still-changing interim text ('' when none).
   */
  onResult(finals: readonly string[], interim: string): void;
  onError(code: RecognitionErrorCode): void;
  /** The run ended: after stop() / abort(), an error, or by itself (silence, service limits). */
  onEnd(): void;
}

/** One continuous recognition run. */
export interface RecognitionRun {
  /** Ends capture; pending audio may still produce a last result. */
  stop(): void;
  /** Ends capture at once, discarding pending audio. */
  abort(): void;
}

export interface SpeechRecognizer {
  readonly supported: boolean;
  /** Starts a continuous run with interim results in `lang` (BCP-47, e.g. 'de-DE'). Throws if it cannot start. */
  start(lang: string, handlers: RecognitionHandlers): RecognitionRun;
}

/** A synthesis voice the device has (SpeechSynthesisVoice). */
export interface SynthVoice {
  /** Stable identifier (voiceURI) — what Preferences.voice.voiceNames stores. */
  id: string;
  name: string;
  /** BCP-47 language, e.g. 'en-GB'. */
  lang: string;
  /** Runs on the device (no network). */
  local: boolean;
  /** The platform's default voice. */
  isDefault: boolean;
}

export interface SpeakOptions {
  lang: string;
  /** A SynthVoice id; null (or a voice the device lacks) = the platform's voice for `lang`. */
  voiceId: string | null;
  /** Rate multiplier (VOICE_LIMITS.speakingRate). */
  rate: number;
}

export interface SpeakHandlers {
  onStart?(): void;
  /** Finished speaking this text (not called after cancel()). */
  onEnd(): void;
  /** Could not speak it (not called after cancel()). */
  onError(code: string): void;
}

export interface SpeechSynthesizer {
  readonly supported: boolean;
  voices(): SynthVoice[];
  /** Voices load asynchronously in some browsers; returns an unsubscribe function. */
  onVoicesChanged(listener: () => void): () => void;
  /** Queues one utterance; at most one is spoken at a time by the controller. */
  speak(text: string, options: SpeakOptions, handlers: SpeakHandlers): void;
  /** Stops speaking at once and drops anything queued (no onEnd / onError afterwards). */
  cancel(): void;
}

/** Microphone access for voice input (getUserMedia: the permission prompt, the level meter). */
export type MicResult = 'granted' | 'denied' | 'no-mic' | 'error';
