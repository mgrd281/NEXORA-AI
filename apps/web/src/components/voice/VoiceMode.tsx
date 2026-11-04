'use client';

import type { Locale, TaskSummary } from '@jarvis/contracts';
import { Keyboard, Mic, Square } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Presence } from '@/components/presence/Presence';
import { useOptionalShell } from '@/components/shell/ShellContext';
import type { PresenceState } from '@/components/presence/model';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { localeFromSpeech, type SpeechLocale } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';
import { api, newIdempotencyKey } from '@/lib/api/client';
import { useCreateTask, useMe } from '@/lib/api/hooks';
import {
  getSpeechRecognition,
  isVoiceInputSupported,
  joinTranscript,
  readResults,
  type SpeechRecognitionLike,
} from './speech';
import { useMicLevel } from './useMicLevel';
import styles from './VoiceMode.module.css';

type Phase =
  | 'unsupported'
  | 'requesting'
  | 'listening'
  | 'paused'
  | 'no-speech'
  | 'denied'
  | 'no-mic'
  | 'error'
  | 'sending';

const MAX_REQUEST = 4000;
const SPEECH_LOCALES: readonly SpeechLocale[] = ['en-US', 'de-DE', 'ar-SA'];
const LANGUAGE_KEY = { 'en-US': 'enUS', 'de-DE': 'deDE', 'ar-SA': 'arSA' } as const;

export interface VoiceModeProps {
  open: boolean;
  onClose: () => void;
  /** Receives what was heard so far when the user switches to typing. */
  onTypeInstead?: (transcript: string) => void;
  /** Called with the created task; by default the app opens the task. */
  onCreated?: (task: TaskSummary) => void;
  /**
   * Sends the dictated request instead of POST /v1/tasks (e.g. as a follow-up in a
   * conversation, with the composer's files). It owns the Idempotency-Key.
   */
  submit?: (body: VoiceRequest) => Promise<TaskSummary>;
  /** The confirmation after sending (default: "Request sent."). */
  sentMessage?: string;
}

export interface VoiceRequest {
  request: string;
  source: 'voice';
  language: Locale;
  voiceSessionId?: string;
}

/**
 * Voice mode: real dictation with the browser's Web Speech API, the Presence ring driven by
 * the live microphone level (getUserMedia + AnalyserNode), and the request sent as a task
 * (source 'voice'). Only session metadata reaches the API — never audio or transcript text.
 */
export function VoiceMode({
  open,
  onClose,
  onTypeInstead,
  onCreated,
  submit,
  sentMessage,
}: VoiceModeProps) {
  const { t } = useI18n();
  return (
    <Sheet open={open} onClose={onClose} title={t('voice.title')} fullScreenOnMobile>
      {open && (
        <VoiceSession
          onClose={onClose}
          onTypeInstead={onTypeInstead}
          onCreated={onCreated}
          submit={submit}
          sentMessage={sentMessage}
        />
      )}
    </Sheet>
  );
}

function VoiceSession({
  onClose,
  onTypeInstead,
  onCreated,
  submit,
  sentMessage,
}: Omit<VoiceModeProps, 'open'>) {
  const { t, speechLocale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const me = useMe();
  const createTask = useCreateTask();

  const preferred = me.data?.preferences.voice.recognitionLocale;
  const [lang, setLang] = useState<SpeechLocale>(
    preferred && preferred !== 'auto' ? preferred : speechLocale,
  );
  const [phase, setPhase] = useState<Phase>(() =>
    isVoiceInputSupported() ? 'requesting' : 'unsupported',
  );
  const [committed, setCommitted] = useState('');
  const [final, setFinal] = useState('');
  const [interim, setInterim] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [sendError, setSendError] = useState<unknown>(null);
  const level = useMicLevel(phase === 'listening' ? stream : null);

  // The app-wide Presence shows 'listening' while this device is capturing speech.
  const setShellListening = useOptionalShell()?.setListening;
  useEffect(() => {
    setShellListening?.(phase === 'listening');
    return () => setShellListening?.(false);
  }, [phase, setShellListening]);

  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const restartAfterEnd = useRef(false);
  const restart = useRef<() => void>(() => undefined);
  const root = useRef<HTMLDivElement>(null);
  const session = useRef<{ id: Promise<string | null>; ended: boolean } | null>(null);
  const idempotencyKey = useRef(newIdempotencyKey());
  const errorCode = useRef<string | undefined>(undefined);
  // Mirrors for callbacks that outlive a render (recognition events, unmount).
  const live = useRef({ phase, lang, committed, final, interim });
  useEffect(() => {
    live.current = { phase, lang, committed, final, interim };
  });

  const heard = joinTranscript(committed, final);
  const fullText = joinTranscript(committed, final, interim);

  const endSession = useCallback(
    (outcome: 'submitted' | 'cancelled' | 'error' | 'no_speech', chars: number) => {
      const s = session.current;
      if (!s || s.ended) return;
      s.ended = true;
      void s.id.then((id) => {
        if (!id) return;
        return api
          .call('endVoiceSession', {
            params: { id },
            body: {
              outcome,
              transcriptChars: Math.min(chars, 10_000),
              ...(errorCode.current ? { errorCode: errorCode.current.slice(0, 64) } : {}),
            },
          })
          .catch(() => undefined);
      });
    },
    [],
  );

  const startRecognition = useCallback(() => {
    const Ctor = getSpeechRecognition();
    if (!Ctor) {
      setPhase('unsupported');
      return;
    }
    const rec = new Ctor();
    rec.lang = live.current.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let lastFinal = '';
    rec.onresult = (event) => {
      const { final: f, interim: i } = readResults(event);
      setFinal(f);
      setInterim(i);
      if (f !== lastFinal) {
        setAnnouncement(f.slice(lastFinal.length).trim());
        lastFinal = f;
      }
    };
    rec.onerror = (event) => {
      if (event.error === 'aborted') return;
      errorCode.current = event.error;
      const hasText = joinTranscript(live.current.committed, live.current.final) !== '';
      if (event.error === 'no-speech') setPhase(hasText ? 'paused' : 'no-speech');
      else if (event.error === 'not-allowed') setPhase('denied');
      else if (event.error === 'audio-capture') setPhase('no-mic');
      else setPhase('error');
    };
    rec.onend = () => {
      if (recognition.current !== rec) return;
      recognition.current = null;
      setCommitted((c) => joinTranscript(c, lastFinal));
      setFinal('');
      setInterim('');
      if (restartAfterEnd.current) {
        restartAfterEnd.current = false;
        restart.current();
        return;
      }
      setPhase((p) => {
        if (p !== 'listening') return p;
        return joinTranscript(live.current.committed, lastFinal) !== '' ? 'paused' : 'no-speech';
      });
    };
    recognition.current = rec;
    try {
      rec.start();
      setPhase('listening');
    } catch {
      recognition.current = null;
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    restart.current = startRecognition;
  }, [startRecognition]);

  const acquire = useCallback(async () => {
    setPhase('requesting');
    errorCode.current = undefined;
    try {
      const media =
        stream ??
        (await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        }));
      setStream(media);
      if (!session.current) {
        session.current = {
          ended: false,
          id: api
            .call('startVoiceSession', {
              body: { locale: live.current.lang, engine: 'browser_speech' },
            })
            .then(
              (s) => s.id,
              () => null,
            ),
        };
      }
      startRecognition();
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      errorCode.current = name || 'getUserMedia';
      if (name === 'NotAllowedError' || name === 'SecurityError') setPhase('denied');
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') setPhase('no-mic');
      else setPhase('error');
    }
  }, [stream, startRecognition]);

  // Start once on open.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || live.current.phase === 'unsupported') return;
    started.current = true;
    void acquire();
  }, [acquire]);

  // Release the microphone and close the session record when the overlay goes away.
  useEffect(() => {
    return () => {
      restartAfterEnd.current = false;
      recognition.current?.abort();
      recognition.current = null;
    };
  }, []);
  useEffect(() => {
    return () => stream?.getTracks().forEach((track) => track.stop());
  }, [stream]);
  useEffect(() => {
    return () => {
      const { phase: p, committed: c, final: f, interim: i } = live.current;
      const chars = joinTranscript(c, f, i).length;
      const outcome =
        p === 'no-speech'
          ? 'no_speech'
          : p === 'error' || p === 'denied' || p === 'no-mic'
            ? 'error'
            : 'cancelled';
      endSession(outcome, chars);
    };
  }, [endSession]);

  const stopListening = () => {
    if (recognition.current) {
      recognition.current.stop();
      setPhase('paused');
    }
  };
  const resume = () => {
    setSendError(null);
    if (stream && phase !== 'denied' && phase !== 'no-mic') startRecognition();
    else void acquire();
  };
  const changeLanguage = (next: SpeechLocale) => {
    setLang(next);
    live.current.lang = next;
    if (recognition.current && phase === 'listening') {
      restartAfterEnd.current = true;
      recognition.current.stop();
    }
  };

  const send = async () => {
    const text = fullText.trim();
    if (!text || text.length > MAX_REQUEST) return;
    restartAfterEnd.current = false;
    const rec = recognition.current;
    recognition.current = null;
    rec?.abort();
    setCommitted(text);
    setFinal('');
    setInterim('');
    setSendError(null);
    setPhase('sending');
    const voiceSessionId = (await session.current?.id) ?? undefined;
    try {
      const body: VoiceRequest = {
        request: text,
        source: 'voice',
        language: localeFromSpeech(lang),
        voiceSessionId,
      };
      const task = submit
        ? await submit(body)
        : await createTask.mutateAsync({ body, idempotencyKey: idempotencyKey.current });
      endSession('submitted', text.length);
      toast({ message: sentMessage ?? t('composer.sent') });
      onClose();
      if (onCreated) onCreated(task);
      else router.push(`/tasks/${task.id}`);
    } catch (err) {
      setSendError(err);
      setPhase('paused');
    }
  };

  const cancel = () => onClose();
  const typeInstead = () => {
    endSession('cancelled', fullText.length);
    onTypeInstead?.(fullText);
    onClose();
  };

  // Space stops / resumes listening (unless focus is on a control that uses Space itself).
  const toggle = useRef<() => void>(() => undefined);
  useEffect(() => {
    toggle.current = () => {
      if (phase === 'listening') stopListening();
      else if (phase === 'paused' || phase === 'no-speech') resume();
    };
  });
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.repeat) return;
      if ((e.target as HTMLElement).closest('button, select, input, textarea, a')) return;
      e.preventDefault();
      toggle.current();
    };
    const dialog: HTMLElement = el.closest('dialog') ?? el;
    dialog.addEventListener('keydown', onKeyDown);
    return () => dialog.removeEventListener('keydown', onKeyDown);
  }, []);

  const status = STATUS[phase];
  const presence: PresenceState =
    phase === 'listening'
      ? 'listening'
      : phase === 'sending'
        ? 'thinking'
        : phase === 'denied' || phase === 'error' || phase === 'no-mic'
          ? 'failed'
          : 'idle';
  const tooLong = fullText.length > MAX_REQUEST;
  const canSend =
    fullText.trim() !== '' && !tooLong && (phase === 'listening' || phase === 'paused');
  const blocked =
    phase === 'unsupported' || phase === 'denied' || phase === 'no-mic' || phase === 'error';

  return (
    <div className={styles.voice} ref={root}>
      <div className={styles.stage}>
        <Presence state={presence} level={level} size={96} label={t(status.title)} />
        <p className={styles.status} role="status" aria-live="polite">
          {t(status.title)}
        </p>
        {status.help && <p className={styles.help}>{t(status.help)}</p>}
      </div>

      {(!blocked || fullText) && (
        <section className={styles.transcript} aria-label={t('voice.transcriptLabel')}>
          {fullText ? (
            <p dir="auto" className={styles.transcriptText}>
              <span>{heard}</span>
              {interim && (
                <>
                  {heard ? ' ' : ''}
                  <span className={styles.interim}>{interim}</span>
                </>
              )}
            </p>
          ) : (
            <p className={styles.placeholder}>{t('voice.transcriptEmpty')}</p>
          )}
          {tooLong && (
            <p className={styles.tooLong}>
              {t('composer.tooLong', { count: fullText.length - MAX_REQUEST })}
            </p>
          )}
        </section>
      )}
      <span className="visually-hidden" aria-live="polite">
        {announcement}
      </span>

      {sendError ? <ErrorBanner error={sendError} /> : null}

      <div className={styles.settings}>
        {phase !== 'unsupported' && (
          <Select
            label={t('voice.language')}
            size="sm"
            value={lang}
            onChange={(e) => changeLanguage(e.target.value as SpeechLocale)}
            disabled={phase === 'sending'}
            fieldClassName={styles.language}
          >
            {SPEECH_LOCALES.map((l) => (
              <option key={l} value={l}>
                {t(`voice.languages.${LANGUAGE_KEY[l]}`)}
              </option>
            ))}
          </Select>
        )}
        <p className={styles.privacy}>{t('voice.privacy')}</p>
        {(phase === 'listening' || phase === 'paused') && (
          <p className={styles.spaceHint}>{t('voice.spaceHint')}</p>
        )}
      </div>

      <div className={styles.actions}>
        <Button variant="ghost" onClick={cancel} disabled={phase === 'sending'}>
          {t('voice.cancel')}
        </Button>
        <div className={styles.actionsEnd}>
          <Button
            variant={blocked ? 'primary' : 'secondary'}
            icon={Keyboard}
            onClick={typeInstead}
            disabled={phase === 'sending'}
          >
            {t('voice.typeInstead')}
          </Button>
          {phase === 'listening' ? (
            <Button variant="secondary" icon={Square} onClick={stopListening}>
              {t('voice.stop')}
            </Button>
          ) : phase === 'paused' ||
            phase === 'no-speech' ||
            phase === 'error' ||
            phase === 'denied' ||
            phase === 'no-mic' ? (
            <Button variant="secondary" icon={Mic} onClick={resume}>
              {phase === 'paused' ? t('voice.resume') : t('voice.tryAgain')}
            </Button>
          ) : null}
          {!blocked && (
            <Button
              variant="primary"
              onClick={() => void send()}
              disabled={!canSend && phase !== 'sending'}
              loading={phase === 'sending'}
              aria-label={t('voice.sendLabel')}
            >
              {phase === 'sending' ? t('voice.sending') : t('voice.send')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS = {
  unsupported: { title: 'voice.states.unsupported', help: 'voice.states.unsupportedHelp' },
  requesting: { title: 'voice.states.requesting', help: null },
  listening: { title: 'voice.states.listening', help: null },
  paused: { title: 'voice.states.paused', help: null },
  'no-speech': { title: 'voice.states.noSpeech', help: 'voice.states.noSpeechHelp' },
  denied: { title: 'voice.states.denied', help: 'voice.states.deniedHelp' },
  'no-mic': { title: 'voice.states.noMicrophone', help: 'voice.states.noMicrophoneHelp' },
  error: { title: 'voice.states.error', help: 'voice.states.errorHelp' },
  sending: { title: 'voice.states.sending', help: null },
} as const satisfies Record<Phase, { title: string; help: string | null }>;
