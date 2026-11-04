/**
 * Deterministic test doubles of the speech seams (components/voice/engine/types.ts). Test code
 * only: the app uses the Web Speech adapters of engine/browser.ts.
 */
import type {
  RecognitionErrorCode,
  RecognitionHandlers,
  RecognitionRun,
  SpeakHandlers,
  SpeakOptions,
  SpeechRecognizer,
  SpeechSynthesizer,
  SynthVoice,
} from '@/components/voice/engine/types';

export class FakeRun implements RecognitionRun {
  ended = false;
  stopped = false;
  aborted = false;
  constructor(
    readonly lang: string,
    private readonly handlers: RecognitionHandlers,
  ) {}

  /** The recogniser heard something: segments that became final, and the interim text. */
  hear(finals: string[], interim = ''): void {
    if (!this.ended) this.handlers.onResult(finals, interim);
  }

  error(code: RecognitionErrorCode): void {
    if (this.ended) return;
    this.handlers.onError(code);
    this.end();
  }

  /** The run ended by itself (like Chrome after a silence). */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.handlers.onEnd();
  }

  stop(): void {
    this.stopped = true;
    this.end();
  }

  abort(): void {
    this.aborted = true;
    // Like the browser: an 'aborted' error, then the end — the controller must ignore both.
    if (!this.ended) this.handlers.onError('aborted');
    this.end();
  }
}

export class FakeRecognizer implements SpeechRecognizer {
  supported = true;
  failStart = false;
  readonly runs: FakeRun[] = [];

  start(lang: string, handlers: RecognitionHandlers): RecognitionRun {
    if (this.failStart) throw new Error('start failed');
    const run = new FakeRun(lang, handlers);
    this.runs.push(run);
    return run;
  }

  /** The run that is still capturing. */
  get live(): FakeRun {
    const run = [...this.runs].reverse().find((r) => !r.ended);
    if (!run) throw new Error('no live recognition run');
    return run;
  }

  get isListening(): boolean {
    return this.runs.some((r) => !r.ended);
  }
}

export interface SpokenRecord extends SpeakOptions {
  text: string;
}

export class FakeSynth implements SpeechSynthesizer {
  supported = true;
  readonly spoken: SpokenRecord[] = [];
  cancels = 0;
  private current: { text: string; handlers: SpeakHandlers } | null = null;
  private readonly list: SynthVoice[];

  constructor(voices: SynthVoice[] = []) {
    this.list = voices;
  }

  voices(): SynthVoice[] {
    return this.list;
  }

  onVoicesChanged(): () => void {
    return () => undefined;
  }

  speak(text: string, options: SpeakOptions, handlers: SpeakHandlers): void {
    this.spoken.push({ text, ...options });
    this.current = { text, handlers };
  }

  /** What is being spoken now (null when silent). */
  get speaking(): string | null {
    return this.current?.text ?? null;
  }

  /** The current utterance finished. */
  finish(): void {
    const c = this.current;
    this.current = null;
    c?.handlers.onEnd();
  }

  /** Finishes everything queued, one after another. */
  finishAll(max = 50): void {
    for (let i = 0; i < max && this.current; i++) this.finish();
  }

  cancel(): void {
    this.cancels++;
    this.current = null;
  }

  get texts(): string[] {
    return this.spoken.map((s) => s.text);
  }
}
