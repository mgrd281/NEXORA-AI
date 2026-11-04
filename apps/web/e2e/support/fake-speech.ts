/**
 * A deterministic stand-in for the browser's Web Speech API in visual / behaviour tests (test
 * code only; headless Chromium has no speech service and no speech output). It replaces
 * SpeechRecognition, speechSynthesis / SpeechSynthesisUtterance and the microphone
 * (getUserMedia) before the app loads, so the app's real adapters (components/voice/engine/
 * browser.ts) run against it. Tests drive it through `speech(page)`.
 */
import type { Page } from '@playwright/test';

export interface FakeSpeechOptions {
  /** getUserMedia outcome (default granted). */
  mic?: 'granted' | 'denied' | 'no-mic';
  /** No SpeechRecognition at all (like Firefox). */
  noRecognition?: boolean;
  /** No speechSynthesis (captions only). */
  noSynthesis?: boolean;
  /** Utterances finish by themselves after this many ms (default: only when told). */
  autoFinishMs?: number;
  voices?: Array<{ voiceURI: string; name: string; lang: string; localService: boolean }>;
}

export interface SpeechControl {
  /** Recognition results: segments that became final, and the interim text. */
  hear(finals: string[], interim?: string): Promise<void>;
  /** A recognition error (e.g. 'network'), then the run ends. */
  error(code: string): Promise<void>;
  /** Finishes the utterance being spoken. */
  finish(): Promise<void>;
  /** Everything passed to speechSynthesis.speak, in order. */
  spoken(): Promise<Array<{ text: string; lang: string; rate: number; voice: string | null }>>;
  /** What is being spoken right now. */
  speaking(): Promise<string | null>;
  /** Live recognition runs (started and not ended). */
  listening(): Promise<number>;
  /** Languages of the recognition runs started so far. */
  runs(): Promise<string[]>;
}

export async function installFakeSpeech(page: Page, options: FakeSpeechOptions = {}) {
  await page.addInitScript((o: FakeSpeechOptions) => {
    type Result = { transcript: string; confidence: number }[] & { isFinal: boolean };
    const w = window as unknown as Record<string, unknown>;
    const state = {
      runs: [] as Array<{ lang: string; rec: FakeRecognition }>,
      spoken: [] as Array<{ text: string; lang: string; rate: number; voice: string | null }>,
      current: null as null | FakeUtterance,
    };

    class FakeRecognition extends EventTarget {
      lang = '';
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onstart: (() => void) | null = null;
      ended = true;
      finals: string[] = [];
      start() {
        this.ended = false;
        this.finals = [];
        state.runs.push({ lang: this.lang, rec: this });
        setTimeout(() => this.onstart?.(), 0);
      }
      emit(finals: string[], interim: string) {
        if (this.ended) return;
        this.finals.push(...finals);
        const results: Result[] = this.finals.map((t) =>
          Object.assign([{ transcript: t, confidence: 0.92 }], { isFinal: true }),
        );
        if (interim)
          results.push(
            Object.assign([{ transcript: interim, confidence: 0.5 }], { isFinal: false }),
          );
        this.onresult?.({ resultIndex: 0, results });
      }
      fail(code: string) {
        if (this.ended) return;
        this.onerror?.({ error: code, message: '' });
        this.finish();
      }
      finish() {
        if (this.ended) return;
        this.ended = true;
        setTimeout(() => this.onend?.(), 0);
      }
      stop() {
        this.finish();
      }
      abort() {
        if (this.ended) return;
        this.onerror?.({ error: 'aborted', message: '' });
        this.finish();
      }
    }

    class FakeUtterance {
      lang = '';
      rate = 1;
      voice: { voiceURI: string } | null = null;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      constructor(readonly text: string) {}
    }

    const voices = (o.voices ?? []).map((v) => ({ ...v, default: false }));
    const synth = {
      speak(u: FakeUtterance) {
        state.spoken.push({
          text: u.text,
          lang: u.lang,
          rate: u.rate,
          voice: u.voice?.voiceURI ?? null,
        });
        state.current = u;
        setTimeout(() => u.onstart?.(), 0);
        if (o.autoFinishMs !== undefined) {
          setTimeout(() => {
            if (state.current === u) control.finish();
          }, o.autoFinishMs);
        }
      },
      cancel() {
        const u = state.current;
        state.current = null;
        u?.onerror?.({ error: 'interrupted' });
      },
      getVoices: () => voices,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      speaking: false,
      pending: false,
      paused: false,
    };

    const control = {
      hear(finals: string[], interim = '') {
        const live = state.runs.filter((r) => !r.rec.ended);
        live.at(-1)?.rec.emit(finals, interim);
      },
      error(code: string) {
        const live = state.runs.filter((r) => !r.rec.ended);
        live.at(-1)?.rec.fail(code);
      },
      finish() {
        const u = state.current;
        state.current = null;
        u?.onend?.();
      },
      spoken: () => state.spoken,
      speaking: () => state.current?.text ?? null,
      listening: () => state.runs.filter((r) => !r.rec.ended).length,
      runs: () => state.runs.map((r) => r.lang),
    };
    w.__speech = control;

    if (o.noRecognition) {
      delete w.SpeechRecognition;
      delete w.webkitSpeechRecognition;
    } else {
      w.SpeechRecognition = FakeRecognition;
      w.webkitSpeechRecognition = FakeRecognition;
    }
    if (o.noSynthesis) {
      delete (window as unknown as Record<string, unknown>).speechSynthesis;
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined });
      delete w.SpeechSynthesisUtterance;
    } else {
      w.SpeechSynthesisUtterance = FakeUtterance;
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
    }

    const media = navigator.mediaDevices ?? ({} as MediaDevices);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: media });
    media.getUserMedia = async () => {
      if (o.mic === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
      if (o.mic === 'no-mic') throw new DOMException('Requested device not found', 'NotFoundError');
      // A silent track, so the level meter has something to read.
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const osc = ctx.createOscillator();
      osc.connect(gain).connect(dest);
      osc.start();
      return dest.stream;
    };
  }, options);
}

export function speech(page: Page): SpeechControl {
  type W = { __speech: Record<string, (...args: unknown[]) => unknown> };
  const call = <T>(name: string, ...args: unknown[]) =>
    page.evaluate(
      ([n, a]) => (window as unknown as W).__speech[n as string]!(...(a as unknown[])),
      [name, args] as const,
    ) as Promise<T>;
  return {
    hear: (finals, interim = '') => call('hear', finals, interim),
    error: (code) => call('error', code),
    finish: () => call('finish'),
    spoken: () => call('spoken'),
    speaking: () => call('speaking'),
    listening: () => call('listening'),
    runs: () => call('runs'),
  };
}
