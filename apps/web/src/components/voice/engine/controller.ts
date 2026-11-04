/**
 * Voice conversation mode as a state machine (docs/architecture/phase-d.md §3.1, ADR-0019):
 *
 *   listen → end of utterance (a final result + `silenceMs` of silence) → submit (a new task,
 *   then follow-ups in the same conversation; one Idempotency-Key per utterance, kept across
 *   network retries) → thinking (only while the task really works) → speak the reply sentence by
 *   sentence as the streamed answer arrives → listen again.
 *
 * Barge-in: speech that is not the echo of what JARVIS is saying cancels speaking at once and the
 * turn passes to the user. Approvals are never given by voice: while one waits, the controller
 * says so and the UI shows the ApprovalSheet. "stop" / "stopp" / "توقف" (VOICE_LIMITS) end voice
 * mode — never the task. Idle conversations end after VOICE_LIMITS.idleEndSeconds (announced).
 * Recognition restarts after network errors with VOICE_LIMITS.reconnectDelaysMs.
 *
 * Pure TypeScript over the speech seams of ./types: no React, no DOM, no network of its own (the
 * UI passes `submit` and feeds task updates from the realtime stream), so tests drive it with fake
 * recognisers, synthesisers and timers. Only metadata leaves it (counters for the voice session).
 */
import type { Locale, TaskStatus, VoiceEndReason } from '@jarvis/contracts';
import { VOICE_LIMITS } from '@jarvis/contracts';
import { chunkForSpeech, isAffirmation, isEcho, isStopPhrase, takeSentences } from './text';
import type {
  MicResult,
  RecognitionErrorCode,
  RecognitionRun,
  SpeechRecognizer,
  SpeechSynthesizer,
} from './types';

/** Where the conversation is (the turn), independent of the microphone. */
export type TurnState =
  | 'ready'
  | 'submitting'
  | 'retrying'
  | 'thinking'
  | 'speaking'
  | 'awaiting_approval'
  | 'failed'
  | 'ended';

/** The microphone / recogniser. */
export type MicState =
  'off' | 'starting' | 'on' | 'muted' | 'denied' | 'no-mic' | 'unsupported' | 'error';

export type CaptionKind =
  'request' | 'answer' | 'result' | 'question' | 'error' | 'approval' | 'busy' | 'notice';

/** One line of the captions: what the user said or typed, or what JARVIS said. */
export interface Caption {
  id: number;
  speaker: 'user' | 'jarvis';
  text: string;
  /** BCP-47 language of the text. */
  lang: string;
  kind: CaptionKind;
  /** JARVIS stopped speaking it because the user spoke (barge-in). */
  interrupted: boolean;
  /** The user typed it (text fallback) instead of saying it. */
  typed: boolean;
  /** Not sent (JARVIS was busy or waiting, or sending failed): it went to the text field. */
  unsent: boolean;
  /** Spoken assent while an approval waits: not a decision (approvals are on screen only). */
  assent: boolean;
  taskId: string | null;
}

/** A line for JARVIS to say (already localized by the UI). */
export interface SpokenLine {
  text: string;
  lang: string;
  kind: CaptionKind;
}

/** The task a turn waits for, as the UI sees it (React Query, refreshed by the realtime stream). */
export interface TaskView {
  id: string;
  status: TaskStatus;
  conversationId: string | null;
  /** The stored answer (TaskDetail.answer) once known. */
  answer: string | null;
  /** BCP-47 language of the answer (the request's language). */
  answerLang: string;
  /** What to say once the task asks, waits or ended (localized by the UI); null while working. */
  line: SpokenLine | null;
  /** The pending approval (AWAITING_APPROVAL). */
  approvalId: string | null;
}

export interface SubmitRequest {
  text: string;
  source: 'voice' | 'text';
  language: Locale;
  /** One per utterance, reused for every retry of it. */
  idempotencyKey: string;
  /** null: the first request (a new task); else a follow-up in this conversation. */
  conversationId: string | null;
}

export interface SubmittedTask {
  id: string;
  conversationId: string | null;
  status: TaskStatus;
}

/** How a failed submit is handled: retried (network), "still busy" (409), or shown. */
export type SubmitFailure = 'network' | 'busy' | 'fatal';

/** Client copy in the interface language (a sentence and its BCP-47 language). */
export interface ConversationCopy {
  lang: string;
  /** "This needs your approval on screen — I can't take approvals by voice." */
  approvalOnScreen: string;
  /** "I'm still working on your last request…" */
  busy: string;
  /** "Still there? Voice mode ends soon unless you say something." */
  idleWarning: string;
}

export interface ConversationSettings {
  /** Recognition language, BCP-47 ('de-DE'). */
  recognitionLang: string;
  /** The request language for it. */
  language: Locale;
  /** End of an utterance: silence after the last final result. */
  silenceMs: number;
  /** Speaking rate multiplier. */
  rate: number;
  /** The voice for a language ('de-DE' → Preferences.voice.voiceNames.de), null = default. */
  voiceFor: (lang: string) => string | null;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ConversationCounters {
  /** Requests sent. */
  turns: number;
  bargeIns: number;
  /** Submit retries and recognition restarts after errors. */
  reconnects: number;
  /** Characters of the requests sent. */
  chars: number;
}

export interface ConversationEnd {
  reason: VoiceEndReason;
  counters: ConversationCounters;
  /** The recogniser's last error code, if any (metadata only). */
  errorCode: string | null;
}

export interface ConversationDeps {
  recognizer: SpeechRecognizer;
  synthesizer: SpeechSynthesizer;
  /** Asks for the microphone (the permission prompt) and keeps it for the level meter. */
  acquireMic: () => Promise<MicResult>;
  submit: (request: SubmitRequest) => Promise<SubmittedTask>;
  classifyError: (error: unknown) => SubmitFailure;
  newKey: () => string;
  copy: ConversationCopy;
  settings: ConversationSettings;
  timers?: Timers;
  now?: () => number;
  delaysMs?: readonly number[];
  idleEndMs?: number;
  /** How long before the idle end it is announced. */
  idleWarnBeforeMs?: number;
  onEnded?: (end: ConversationEnd) => void;
  /** Puts an utterance that was not sent into the overlay's text field. */
  onDraft?: (text: string) => void;
}

export type ConversationNotice = 'busy' | 'approvalOnScreen' | 'idleWarning' | null;

export interface ConversationSnapshot {
  turn: TurnState;
  mic: MicState;
  /** The words of the current utterance so far (final) and the still-changing part. */
  heard: string;
  interim: string;
  captions: readonly Caption[];
  /** The task of the current turn. */
  taskId: string | null;
  conversationId: string | null;
  approvalId: string | null;
  /** The last failure: of sending (with retries exhausted or refused) or of the recogniser. */
  error: { source: 'submit' | 'recognition'; error: unknown } | null;
  notice: ConversationNotice;
  /** Live updates are reconnecting (the stream), so the state may be behind. */
  streamDown: boolean;
  /** What is being spoken right now. */
  speaking: SpokenLine | null;
  counters: ConversationCounters;
  endReason: VoiceEndReason | null;
}

const ACTIVE: ReadonlySet<TaskStatus> = new Set(['QUEUED', 'PLANNING', 'RUNNING', 'VERIFYING']);
const TERMINAL: ReadonlySet<TaskStatus> = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']);
/** After JARVIS stops speaking, recognition may still deliver its own words for a moment. */
const ECHO_GRACE_MS = 1500;
/** The idle end is announced this long before. */
const IDLE_WARN_BEFORE_MS = 10_000;

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Pending {
  request: SubmitRequest;
  attempt: number;
  captionId: number;
}

export class ConversationController {
  private snap: ConversationSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly delays: readonly number[];
  private deps: ConversationDeps;

  // Recognition
  private run: RecognitionRun | null = null;
  private runId = 0;
  private wantRecognition = false;
  private recognitionAttempt = 0;
  private restartTimer: unknown = null;
  private lastErrorCode: string | null = null;
  private utterance: string[] = [];
  private eouTimer: unknown = null;
  private idleWarnTimer: unknown = null;
  private idleEndTimer: unknown = null;

  // Speaking
  private queue: Array<SpokenLine & { group: string }> = [];
  private current: (SpokenLine & { group: string; captionId: number }) | null = null;
  private speakGen = 0;
  private recentSpoken: string[] = [];
  private lastSpeechEndAt = -Infinity;
  private lastGroup: { group: string; captionId: number } | null = null;

  // The current turn's task and its streamed answer
  private task: TaskView | null = null;
  private readonly views = new Map<string, TaskView>();
  private stream = { taskId: '', buffer: '', taken: 0, lang: '', muted: false };
  private readonly finished = new Set<string>();
  private readonly announcedApprovals = new Set<string>();
  private pending: Pending | null = null;
  private retryTimer: unknown = null;
  private captionSeq = 0;

  constructor(deps: ConversationDeps, initial: { conversationId?: string | null } = {}) {
    this.deps = deps;
    this.timers = deps.timers ?? defaultTimers;
    this.now = deps.now ?? (() => Date.now());
    this.delays = deps.delaysMs ?? VOICE_LIMITS.reconnectDelaysMs;
    this.snap = {
      turn: 'ready',
      mic: 'off',
      heard: '',
      interim: '',
      captions: [],
      taskId: null,
      conversationId: initial.conversationId ?? null,
      approvalId: null,
      error: null,
      notice: null,
      streamDown: false,
      speaking: null,
      counters: { turns: 0, bargeIns: 0, reconnects: 0, chars: 0 },
      endReason: null,
    };
  }

  /* -------------------------------------------------------------- subscription */

  getSnapshot = (): ConversationSnapshot => this.snap;

  private isEnded(): boolean {
    return this.snap.turn === 'ended';
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<ConversationSnapshot>): void {
    const before = this.snap.turn;
    this.snap = { ...this.snap, ...patch };
    if (patch.turn && patch.turn !== before) this.onTurnChange(before, patch.turn);
    for (const l of this.listeners) l();
  }

  private bump(counter: keyof ConversationCounters, by = 1): void {
    this.set({ counters: { ...this.snap.counters, [counter]: this.snap.counters[counter] + by } });
  }

  /* -------------------------------------------------------------- inputs */

  /** Settings that may change while the conversation runs (preferences loaded, language). */
  updateSettings(patch: Partial<ConversationSettings>): void {
    const before = this.deps.settings.recognitionLang;
    this.deps = { ...this.deps, settings: { ...this.deps.settings, ...patch } };
    if (patch.recognitionLang && patch.recognitionLang !== before && this.run) {
      this.stopRecognition();
      this.startRecognition();
    }
  }

  updateCopy(copy: ConversationCopy): void {
    this.deps = { ...this.deps, copy };
  }

  /** Asks for the microphone and starts listening (or stays text-only when unsupported). */
  async start(): Promise<void> {
    if (this.snap.turn === 'ended') return;
    if (!this.deps.recognizer.supported) {
      this.set({ mic: 'unsupported' });
      return;
    }
    this.set({ mic: 'starting', error: null });
    let result: MicResult;
    try {
      result = await this.deps.acquireMic();
    } catch {
      result = 'error';
    }
    // The conversation may have ended while the permission prompt was open.
    if (this.isEnded()) return;
    if (result !== 'granted') {
      this.lastErrorCode = `mic-${result}`;
      this.set({ mic: result === 'denied' ? 'denied' : result === 'no-mic' ? 'no-mic' : 'error' });
      return;
    }
    this.wantRecognition = true;
    this.recognitionAttempt = 0;
    this.startRecognition();
  }

  /** Space / the mic button: mute or unmute the microphone (also "Listen again" after errors). */
  toggleMic(): void {
    if (this.snap.mic === 'on') this.pause();
    else void this.resume();
  }

  pause(): void {
    if (this.snap.mic !== 'on' && this.snap.mic !== 'starting') return;
    this.wantRecognition = false;
    this.cancelRestart();
    this.stopRecognition();
    // Words already heard are not lost: they end the utterance now.
    if (this.utterance.length > 0 || this.snap.interim) {
      if (this.snap.interim) this.utterance.push(this.snap.interim);
      this.finishUtterance();
    }
    this.clearIdle();
    this.set({ mic: 'muted', interim: '' });
  }

  async resume(): Promise<void> {
    if (this.snap.turn === 'ended') return;
    const mic = this.snap.mic;
    if (mic === 'on' || mic === 'starting' || mic === 'unsupported') return;
    if (this.snap.turn === 'failed') this.set({ turn: 'ready', error: null });
    else if (this.snap.error?.source === 'recognition') this.set({ error: null });
    if (mic === 'denied' || mic === 'no-mic' || mic === 'off' || mic === 'error') {
      await this.start();
      return;
    }
    this.wantRecognition = true;
    this.recognitionAttempt = 0;
    this.startRecognition();
  }

  /** Typed text (the text fallback): the same path as speech, `source: 'text'`. */
  submitText(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || this.snap.turn === 'ended') return false;
    if (this.snap.turn === 'speaking') this.bargeIn();
    this.clearIdle();
    return this.handleRequest(trimmed, 'text');
  }

  /** The current state of a task (from React Query; refetched on every stream event). */
  updateTask(view: TaskView): void {
    this.views.set(view.id, view);
    if (!this.task || view.id !== this.task.id || this.snap.turn === 'ended') return;
    this.task = view;
    // The request's language as the server detected it decides what is still to be spoken of
    // the streamed answer (it starts as the recognition language).
    if (this.stream.taskId === view.id && view.answerLang) this.stream.lang = view.answerLang;
    if (view.conversationId && !this.snap.conversationId) {
      this.set({ conversationId: view.conversationId });
    }
    if (ACTIVE.has(view.status)) {
      if (this.snap.turn === 'awaiting_approval') this.set({ turn: 'thinking', approvalId: null });
      return;
    }
    if (view.status === 'AWAITING_APPROVAL') {
      const id = view.approvalId ?? `${view.id}:approval`;
      this.set({ approvalId: view.approvalId });
      if (!this.announcedApprovals.has(id)) {
        this.announcedApprovals.add(id);
        this.set({ notice: 'approvalOnScreen' });
        // Said even after a barge-in: the user must know why nothing happens.
        this.enqueue(
          {
            text: this.deps.copy.approvalOnScreen,
            lang: this.deps.copy.lang,
            kind: 'approval',
          },
          `${view.id}:approval:${id}`,
        );
      }
      if (this.snap.turn !== 'speaking') this.set({ turn: this.afterSpeech() });
      return;
    }
    if (TERMINAL.has(view.status) && !this.finished.has(view.id)) {
      this.finished.add(view.id);
      this.set({ approvalId: null, notice: null });
      if (!this.stream.muted) {
        if (view.answer) {
          const answerLang = this.stream.lang || view.answerLang;
          const fromStream =
            this.stream.taskId === view.id &&
            this.stream.taken > 0 &&
            view.answer.startsWith(this.stream.buffer.slice(0, this.stream.taken));
          const { sentences } = takeSentences(
            view.answer,
            fromStream ? this.stream.taken : 0,
            true,
            answerLang,
          );
          for (const sentence of sentences) {
            this.enqueue({ text: sentence, lang: answerLang, kind: 'answer' }, `${view.id}:answer`);
          }
        } else if (view.line) {
          this.enqueue(view.line, `${view.id}:${view.line.kind}`);
        }
      }
      if (this.snap.turn !== 'speaking') this.set({ turn: this.afterSpeech() });
    }
  }

  /** One task.answer.delta of the realtime stream (ephemeral). */
  answerDelta(taskId: string, text: string): void {
    if (!this.task || this.task.id !== taskId || this.snap.turn === 'ended') return;
    if (this.stream.taskId !== taskId || this.stream.muted || this.finished.has(taskId)) return;
    this.stream.buffer += text;
    const { sentences, next } = takeSentences(
      this.stream.buffer,
      this.stream.taken,
      false,
      this.stream.lang,
    );
    this.stream.taken = next;
    for (const sentence of sentences) {
      this.enqueue({ text: sentence, lang: this.stream.lang, kind: 'answer' }, `${taskId}:answer`);
    }
  }

  /** The realtime stream is reconnecting (the UI refetches the task when it is back). */
  setStreamDown(down: boolean): void {
    if (down !== this.snap.streamDown) this.set({ streamDown: down });
  }

  /** End, Esc, a stop phrase, idle, switching to text, leaving the overlay. Never cancels a task. */
  end(reason: VoiceEndReason): void {
    if (this.snap.turn === 'ended') return;
    this.wantRecognition = false;
    this.cancelRestart();
    this.stopRecognition();
    this.clear(this.eouTimer);
    this.eouTimer = null;
    this.clearIdle();
    this.clear(this.retryTimer);
    this.retryTimer = null;
    this.pending = null;
    this.stopSpeaking();
    this.utterance = [];
    this.set({
      turn: 'ended',
      mic: 'off',
      heard: '',
      interim: '',
      speaking: null,
      endReason: reason,
      notice: null,
    });
    this.deps.onEnded?.({
      reason,
      counters: this.snap.counters,
      errorCode: this.lastErrorCode,
    });
  }

  /* -------------------------------------------------------------- recognition */

  private startRecognition(): void {
    if (!this.wantRecognition || this.run || this.snap.turn === 'ended') return;
    const id = ++this.runId;
    try {
      this.run = this.deps.recognizer.start(this.deps.settings.recognitionLang, {
        onResult: (finals, interim) => {
          if (id === this.runId) this.onSpeech(finals, interim);
        },
        onError: (code) => {
          if (id === this.runId) this.onRecognitionError(code);
        },
        onEnd: () => {
          if (id !== this.runId) return;
          this.run = null;
          this.onRecognitionEnd();
        },
      });
    } catch {
      this.run = null;
      this.onRecognitionError('unknown');
      return;
    }
    this.set({ mic: 'on' });
    if (this.snap.turn === 'ready') this.armIdle();
  }

  /** Ends the current run without its callbacks (pause, language change, end). */
  private stopRecognition(): void {
    this.runId++;
    const run = this.run;
    this.run = null;
    try {
      run?.abort();
    } catch {
      // Already ended.
    }
  }

  private cancelRestart(): void {
    this.clear(this.restartTimer);
    this.restartTimer = null;
  }

  private onRecognitionEnd(): void {
    // A last interim the recogniser never finalised still counts as heard.
    if (this.snap.interim) {
      this.utterance.push(this.snap.interim);
      this.set({ interim: '', heard: this.utterance.join(' ') });
      this.scheduleEndOfUtterance();
    }
    if (!this.wantRecognition || this.restartTimer !== null) return;
    // Continuous recognition ends by itself (silence, service limits): listen again at once.
    this.startRecognition();
  }

  private onRecognitionError(code: RecognitionErrorCode): void {
    switch (code) {
      case 'no-speech':
        return; // onEnd restarts it.
      case 'not-allowed':
      case 'service-not-allowed':
        this.lastErrorCode = code;
        this.wantRecognition = false;
        this.set({ mic: 'denied' });
        this.clearIdle();
        return;
      case 'audio-capture':
        this.lastErrorCode = code;
        this.wantRecognition = false;
        this.set({ mic: 'no-mic' });
        this.clearIdle();
        return;
      case 'language-not-supported':
      case 'bad-grammar':
        this.lastErrorCode = code;
        this.wantRecognition = false;
        this.set({ mic: 'error', error: { source: 'recognition', error: code } });
        this.clearIdle();
        return;
      default: {
        // network, an abort we did not ask for, unknown: restart with backoff.
        this.lastErrorCode = code;
        const attempt = this.recognitionAttempt;
        if (attempt >= this.delays.length) {
          this.wantRecognition = false;
          this.cancelRestart();
          this.stopRecognition();
          this.clearIdle();
          this.set({ mic: 'error', error: { source: 'recognition', error: code } });
          return;
        }
        this.recognitionAttempt = attempt + 1;
        this.bump('reconnects');
        this.cancelRestart();
        this.set({ mic: 'starting' });
        this.restartTimer = this.timers.setTimeout(() => {
          this.restartTimer = null;
          this.stopRecognition();
          this.startRecognition();
        }, this.delays[attempt]!);
      }
    }
  }

  private onSpeech(finals: readonly string[], interim: string): void {
    if (this.snap.turn === 'ended' || this.snap.mic !== 'on') return;
    const echoWindow =
      this.snap.turn === 'speaking' || this.now() - this.lastSpeechEndAt < ECHO_GRACE_MS;
    const recent = this.current ? [...this.recentSpoken, this.current.text] : this.recentSpoken;
    const kept = finals
      .map((f) => f.trim())
      .filter((f) => f !== '' && !(echoWindow && isEcho(f, recent)));
    const live = interim.trim() && !(echoWindow && isEcho(interim, recent)) ? interim.trim() : '';
    if (kept.length === 0 && !live) {
      // Only echo (or nothing): an utterance already heard may still end now.
      if (this.snap.interim && !interim.trim()) {
        this.set({ interim: '' });
        this.scheduleEndOfUtterance();
      }
      return;
    }
    // Something the user really said: the recogniser works again.
    this.recognitionAttempt = 0;
    if (this.snap.turn === 'speaking') this.bargeIn();
    this.resetIdle();
    if (this.snap.notice === 'idleWarning') this.set({ notice: null });
    this.utterance.push(...kept);
    this.set({ interim: live, heard: this.utterance.join(' ') });
    this.clear(this.eouTimer);
    this.eouTimer = null;
    if (!live) this.scheduleEndOfUtterance();
  }

  private scheduleEndOfUtterance(): void {
    this.clear(this.eouTimer);
    this.eouTimer = null;
    if (this.utterance.length === 0) return;
    this.eouTimer = this.timers.setTimeout(() => {
      this.eouTimer = null;
      this.finishUtterance();
    }, this.deps.settings.silenceMs);
  }

  private finishUtterance(): void {
    this.clear(this.eouTimer);
    this.eouTimer = null;
    const text = this.utterance.join(' ').replace(/\s+/g, ' ').trim();
    this.utterance = [];
    this.set({ heard: '', interim: '' });
    if (!text) return;
    if (isStopPhrase(text, this.deps.settings.language)) {
      this.end('voice_command');
      return;
    }
    this.handleRequest(text, 'voice');
  }

  /* -------------------------------------------------------------- requests */

  /** True when the request was sent (or is being sent). */
  private handleRequest(text: string, source: 'voice' | 'text'): boolean {
    const lang = this.deps.settings.recognitionLang;
    const status = this.task?.status;
    if (this.snap.turn === 'awaiting_approval' || status === 'AWAITING_APPROVAL') {
      // Never a decision: "yes" is answered with "confirm it on screen"; other words wait.
      const affirm = isAffirmation(text, this.deps.settings.language);
      this.caption({
        speaker: 'user',
        text,
        lang,
        kind: 'request',
        typed: source === 'text',
        unsent: !affirm,
        assent: affirm,
      });
      if (!affirm) this.deps.onDraft?.(text);
      this.set({ notice: 'approvalOnScreen' });
      this.enqueue(
        { text: this.deps.copy.approvalOnScreen, lang: this.deps.copy.lang, kind: 'approval' },
        `notice:${this.captionSeq}`,
      );
      return false;
    }
    if (this.pending || (status !== undefined && ACTIVE.has(status))) {
      this.caption({
        speaker: 'user',
        text,
        lang,
        kind: 'request',
        typed: source === 'text',
        unsent: true,
        assent: false,
      });
      this.deps.onDraft?.(text);
      this.sayBusy();
      return false;
    }
    const captionId = this.caption({
      speaker: 'user',
      text,
      lang,
      kind: 'request',
      typed: source === 'text',
      unsent: false,
      assent: false,
    });
    this.pending = {
      request: {
        text,
        source,
        language: this.deps.settings.language,
        idempotencyKey: this.deps.newKey(),
        conversationId: this.snap.conversationId,
      },
      attempt: 0,
      captionId,
    };
    this.clearIdle();
    this.set({ turn: 'submitting', error: null, notice: null });
    this.send(this.pending);
    return true;
  }

  private send(p: Pending): void {
    this.deps.submit(p.request).then(
      (task) => {
        if (this.pending !== p || this.snap.turn === 'ended') return;
        this.pending = null;
        this.set({
          counters: {
            ...this.snap.counters,
            turns: this.snap.counters.turns + 1,
            chars: this.snap.counters.chars + p.request.text.length,
          },
        });
        this.task = {
          id: task.id,
          status: task.status,
          conversationId: task.conversationId,
          answer: null,
          answerLang: this.deps.settings.recognitionLang,
          line: null,
          approvalId: null,
        };
        this.stream = {
          taskId: task.id,
          buffer: '',
          taken: 0,
          lang: this.deps.settings.recognitionLang,
          muted: false,
        };
        this.setCaptionTask(p.captionId, task.id);
        this.set({
          taskId: task.id,
          conversationId: task.conversationId ?? this.snap.conversationId,
          turn: this.current ? 'speaking' : 'thinking',
          error: null,
        });
        // A state the stream delivered before the request was acknowledged.
        const seen = this.views.get(task.id);
        if (seen) this.updateTask(seen);
      },
      (error: unknown) => {
        if (this.pending !== p || this.snap.turn === 'ended') return;
        const kind = this.deps.classifyError(error);
        if (kind === 'network' && p.attempt < this.delays.length) {
          // Same Idempotency-Key: the server creates the task at most once.
          const delay = this.delays[p.attempt]!;
          p.attempt += 1;
          this.bump('reconnects');
          this.set({ turn: 'retrying', error: { source: 'submit', error } });
          this.retryTimer = this.timers.setTimeout(() => {
            this.retryTimer = null;
            if (this.pending === p) this.send(p);
          }, delay);
          return;
        }
        this.pending = null;
        this.markUnsent(p.captionId);
        this.deps.onDraft?.(p.request.text);
        if (kind === 'busy') {
          this.set({ turn: this.afterSpeech(), error: null });
          this.sayBusy();
          return;
        }
        if (kind === 'network') {
          // Retries exhausted: listening ends; the error is shown and the text is in the field.
          this.wantRecognition = false;
          this.cancelRestart();
          this.stopRecognition();
          this.stopSpeaking();
          this.clearIdle();
          this.set({
            turn: 'failed',
            mic: this.snap.mic === 'unsupported' ? 'unsupported' : 'off',
            error: { source: 'submit', error },
          });
          return;
        }
        this.set({ turn: this.afterSpeech(), error: { source: 'submit', error } });
      },
    );
  }

  private sayBusy(): void {
    this.set({ notice: 'busy' });
    this.enqueue(
      { text: this.deps.copy.busy, lang: this.deps.copy.lang, kind: 'busy' },
      `notice:${this.captionSeq}`,
    );
  }

  /* -------------------------------------------------------------- speaking */

  private enqueue(line: SpokenLine, group: string): void {
    if (this.snap.turn === 'ended') return;
    for (const chunk of chunkForSpeech(line.text)) this.queue.push({ ...line, text: chunk, group });
    this.pump();
  }

  private pump(): void {
    while (!this.current && this.snap.turn !== 'ended') {
      const next = this.queue.shift();
      if (!next) {
        if (this.snap.turn === 'speaking') {
          this.lastSpeechEndAt = this.now();
          this.set({ turn: this.afterSpeech(), speaking: null });
        }
        return;
      }
      const captionId = this.jarvisCaption(next);
      if (!this.deps.synthesizer.supported) continue; // Captions only (no speech output).
      this.current = { ...next, captionId };
      const gen = ++this.speakGen;
      const done = () => {
        if (gen !== this.speakGen || !this.current) return;
        this.recentSpoken = [...this.recentSpoken.slice(-1), this.current.text];
        this.current = null;
        this.lastSpeechEndAt = this.now();
        this.pump();
      };
      this.set({
        turn: 'speaking',
        speaking: { text: next.text, lang: next.lang, kind: next.kind },
      });
      try {
        this.deps.synthesizer.speak(
          next.text,
          {
            lang: next.lang,
            voiceId: this.deps.settings.voiceFor(next.lang),
            rate: this.deps.settings.rate,
          },
          { onEnd: done, onError: done },
        );
      } catch {
        done();
      }
      return;
    }
  }

  /** Stops speaking at once and forgets the queue (barge-in, end, a failure). */
  private stopSpeaking(): void {
    this.speakGen++;
    this.queue = [];
    if (this.current) {
      this.recentSpoken = [...this.recentSpoken.slice(-1), this.current.text];
      this.current = null;
      this.lastSpeechEndAt = this.now();
    }
    try {
      this.deps.synthesizer.cancel();
    } catch {
      // Nothing was speaking.
    }
  }

  /** The user spoke (or typed) while JARVIS was speaking: stop at once, the turn is theirs. */
  private bargeIn(): void {
    const interrupted = this.current?.captionId ?? null;
    // The rest of an interrupted answer is not spoken (it stays on screen in the task). A notice
    // that was interrupted (approval on screen, busy) mutes nothing: the task's result still comes.
    const wasAnswer =
      this.current?.kind === 'answer' || this.queue.some((q) => q.kind === 'answer');
    this.stopSpeaking();
    if (wasAnswer) this.stream.muted = true;
    if (interrupted !== null) {
      this.set({
        captions: this.snap.captions.map((c) =>
          c.id === interrupted ? { ...c, interrupted: true } : c,
        ),
      });
    }
    this.lastGroup = null;
    this.bump('bargeIns');
    this.set({ turn: this.afterSpeech(true), speaking: null });
  }

  /** Where the turn goes once JARVIS has nothing (more) to say. */
  private afterSpeech(userTurn = false): TurnState {
    const turn = this.snap.turn;
    if (turn === 'ended' || turn === 'failed') return turn;
    if (this.pending) return this.retryTimer !== null ? 'retrying' : 'submitting';
    const status = this.task?.status;
    if (status === 'AWAITING_APPROVAL') return 'awaiting_approval';
    if (status && ACTIVE.has(status) && !(userTurn || this.stream.muted)) return 'thinking';
    return 'ready';
  }

  /* -------------------------------------------------------------- captions */

  private caption(c: Omit<Caption, 'id' | 'interrupted' | 'taskId'> & { taskId?: string | null }) {
    const id = ++this.captionSeq;
    this.lastGroup = null;
    this.set({
      captions: [...this.snap.captions, { ...c, id, interrupted: false, taskId: c.taskId ?? null }],
    });
    return id;
  }

  /** JARVIS's sentences of one reply share a caption (appended as they are spoken). */
  private jarvisCaption(line: SpokenLine & { group: string }): number {
    const last = this.lastGroup;
    if (last && last.group === line.group) {
      this.set({
        captions: this.snap.captions.map((c) =>
          c.id === last.captionId ? { ...c, text: `${c.text} ${line.text}` } : c,
        ),
      });
      return last.captionId;
    }
    const id = this.caption({
      speaker: 'jarvis',
      text: line.text,
      lang: line.lang,
      kind: line.kind,
      typed: false,
      unsent: false,
      assent: false,
      taskId: this.task?.id ?? null,
    });
    this.lastGroup = { group: line.group, captionId: id };
    return id;
  }

  private setCaptionTask(id: number, taskId: string): void {
    this.set({ captions: this.snap.captions.map((c) => (c.id === id ? { ...c, taskId } : c)) });
  }

  private markUnsent(id: number): void {
    this.set({
      captions: this.snap.captions.map((c) => (c.id === id ? { ...c, unsent: true } : c)),
    });
  }

  /* -------------------------------------------------------------- idle */

  private onTurnChange(_from: TurnState, to: TurnState): void {
    if (to === 'ready') this.armIdle();
  }

  private armIdle(): void {
    if (this.idleEndTimer !== null || this.snap.mic !== 'on') return;
    const endMs = this.deps.idleEndMs ?? VOICE_LIMITS.idleEndSeconds * 1000;
    const warnBefore = this.deps.idleWarnBeforeMs ?? IDLE_WARN_BEFORE_MS;
    this.idleWarnTimer = this.timers.setTimeout(
      () => {
        this.idleWarnTimer = null;
        if (this.snap.turn !== 'ready') return;
        this.set({ notice: 'idleWarning' });
        this.enqueue(
          { text: this.deps.copy.idleWarning, lang: this.deps.copy.lang, kind: 'notice' },
          `idle:${this.captionSeq}`,
        );
      },
      Math.max(0, endMs - warnBefore),
    );
    this.idleEndTimer = this.timers.setTimeout(() => {
      this.idleEndTimer = null;
      if (this.snap.turn === 'ready' || this.snap.turn === 'speaking') this.end('idle');
    }, endMs);
  }

  private clearIdle(): void {
    this.clear(this.idleWarnTimer);
    this.clear(this.idleEndTimer);
    this.idleWarnTimer = null;
    this.idleEndTimer = null;
  }

  private resetIdle(): void {
    this.clearIdle();
    if (this.snap.turn === 'ready') this.armIdle();
  }

  private clear(handle: unknown): void {
    if (handle !== null && handle !== undefined) this.timers.clearTimeout(handle);
  }
}
