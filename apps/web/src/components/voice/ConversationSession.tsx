'use client';

import type { Approval, TaskSummary, VoiceEndReason } from '@jarvis/contracts';
import { VOICE_LIMITS } from '@jarvis/contracts';
import { ArrowUp, Hand, Keyboard, Mic, MicOff, PhoneOff } from 'lucide-react';
import Link from 'next/link';
import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
  type Ref,
} from 'react';
import { ApprovalSheet } from '@/components/approvals/ApprovalSheet';
import { Presence } from '@/components/presence/Presence';
import { useOptionalShell } from '@/components/shell/ShellContext';
import { Banner, ErrorBanner } from '@/components/ui/Banner';
import { Button, IconButton } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { localeFromSpeech, type SpeechLocale } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';
import { useMe } from '@/lib/api/hooks';
import { cx } from '@/lib/cx';
import type { Caption } from './engine/controller';
import { useMicLevel } from './useMicLevel';
import { displayOf, HELP, PRESENCE } from './display';
import { useVoiceConversation, type VoiceRequestBody } from './useVoiceConversation';
import styles from './ConversationSession.module.css';

const SPEECH_LOCALES: readonly SpeechLocale[] = ['en-US', 'de-DE', 'ar-SA'];
const LANGUAGE_KEY = { 'en-US': 'enUS', 'de-DE': 'deDE', 'ar-SA': 'arSA' } as const;
const MAX_REQUEST = 4000;

export interface ConversationHandle {
  /** Ends voice mode (End, Esc, the close button); the overlay closes once it has ended. */
  end: (reason: VoiceEndReason) => void;
}

export interface ConversationSessionProps {
  ref?: Ref<ConversationHandle>;
  /** Continue this conversation (a follow-up field); otherwise the first request starts one. */
  conversationId?: string | null;
  /** The opening composer's submit (files, its own Idempotency-Key per intent). */
  submit?: (body: VoiceRequestBody) => Promise<TaskSummary>;
  /** Ended: close the overlay; `lastTaskId` is the conversation's newest request, if any. */
  onEnded: (reason: VoiceEndReason, lastTaskId: string | null) => void;
  /** "Type instead": the overlay closes and the text goes to the composer. */
  onTypeInstead?: (text: string) => void;
}

/**
 * Voice conversation mode inside the voice overlay (docs/architecture/phase-d.md §3.1): listens,
 * sends each utterance (the first as a new request, then follow-ups in the same conversation),
 * speaks the reply sentence by sentence as it streams, and listens again. Barge-in by speaking
 * or typing; captions of everything said; a text field at all times; approvals only on screen.
 */
export function ConversationSession({
  ref,
  conversationId = null,
  submit,
  onEnded,
  onTypeInstead,
}: ConversationSessionProps) {
  const { t, speechLocale } = useI18n();
  const me = useMe();
  const preferred = me.data?.preferences.voice.recognitionLocale;
  const [lang, setLang] = useState<SpeechLocale>(
    preferred && preferred !== 'auto' ? preferred : speechLocale,
  );
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const keyboardHintId = useId();

  const voice = useVoiceConversation({
    conversationId,
    firstSubmit: submit,
    recognitionLang: lang,
    onDraft: (draft) => setText((current) => (current.trim() ? `${current} ${draft}` : draft)),
    onEnded: (end, lastTaskId) => onEnded(end.reason, lastTaskId),
  });
  const { controller, snapshot: s } = voice;
  const display = displayOf(s);
  const level = useMicLevel(s.mic === 'on' && s.turn !== 'ended' ? voice.stream : null);

  useImperativeHandle(ref, () => ({ end: (reason) => controller?.end(reason) }), [controller]);

  // The app-wide Presence follows: listening while the mic captures, speaking while JARVIS talks.
  const shell = useOptionalShell();
  const setShellListening = shell?.setListening;
  const setShellSpeaking = shell?.setSpeaking;
  useEffect(() => {
    setShellListening?.(display === 'listening');
    setShellSpeaking?.(display === 'speaking');
  }, [display, setShellListening, setShellSpeaking]);
  useEffect(
    () => () => {
      setShellListening?.(false);
      setShellSpeaking?.(false);
    },
    [setShellListening, setShellSpeaking],
  );

  // Blocked microphone: once the site setting changes to allowed, listen without another click.
  useEffect(() => {
    if (s.mic !== 'denied' || !controller || typeof navigator === 'undefined') return;
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const onChange = () => {
      if (status?.state === 'granted') void controller.resume();
    };
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((result) => {
        if (cancelled) return;
        status = result;
        result.addEventListener('change', onChange);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      status?.removeEventListener('change', onChange);
    };
  }, [s.mic, controller]);

  // A failed send leaves the words in the text field: focus it.
  useEffect(() => {
    if (s.turn === 'failed') inputRef.current?.focus();
  }, [s.turn]);

  // Space turns the microphone on / off (not while a control that uses Space has focus).
  useEffect(() => {
    const dialog: HTMLElement | null = rootRef.current?.closest('dialog') ?? null;
    if (!dialog || !controller) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.repeat || e.defaultPrevented) return;
      if ((e.target as HTMLElement).closest('button, select, input, textarea, a, [role="radio"]'))
        return;
      // Only the voice overlay itself (not the approval sheet on top of it).
      if ((e.target as HTMLElement).closest('dialog') !== dialog) return;
      e.preventDefault();
      controller.toggleMic();
    };
    dialog.addEventListener('keydown', onKeyDown);
    return () => dialog.removeEventListener('keydown', onKeyDown);
  }, [controller]);

  // The approval the task waits for: shown on screen (a tap / click decides, never speech).
  const approval: Approval | null =
    (s.approvalId && voice.task?.approvals.find((a) => a.id === s.approvalId)) || null;
  const [reviewing, setReviewing] = useState<string | null>(null);
  const autoOpened = useRef(new Set<string>());
  useEffect(() => {
    if (!approval || autoOpened.current.has(approval.id)) return;
    autoOpened.current.add(approval.id);
    setReviewing(approval.id);
  }, [approval]);

  const sendTyped = (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (!value || value.length > MAX_REQUEST || !controller) return;
    // Sent, or kept here (busy, waiting for approval) — the controller says which.
    if (controller.submitText(value)) setText('');
  };

  const changeLanguage = (next: SpeechLocale) => setLang(next);
  const stopPhrase = VOICE_LIMITS.stopPhrases[localeFromSpeech(lang)][0];
  const help =
    display === 'unsupported'
      ? voice.synthesisSupported
        ? t('voice.conversation.states.unsupportedHelp')
        : t('voice.conversation.states.unsupportedSilentHelp')
      : HELP[display]
        ? t(HELP[display]!)
        : null;
  const micUsable = s.mic !== 'unsupported';
  const micOn = s.mic === 'on' || s.mic === 'starting';
  const tooLong = text.length > MAX_REQUEST;
  const busySending = s.turn === 'submitting' || s.turn === 'retrying';

  return (
    <div className={styles.conversation} ref={rootRef}>
      <div className={styles.stage}>
        <Presence
          state={PRESENCE[display]}
          level={level}
          size={96}
          label={t(`voice.conversation.states.${display}`)}
        />
        <p className={styles.status} role="status" aria-live="polite">
          {t(`voice.conversation.states.${display}`)}
        </p>
        {help && <p className={styles.help}>{help}</p>}
      </div>

      {!voice.synthesisSupported && (
        <Banner tone="info" title={t('voice.conversation.noSpeechOutput')} />
      )}
      {s.notice === 'idleWarning' && s.turn !== 'ended' && (
        <Banner tone="warning" live title={t('voice.conversation.lines.idleWarning')} />
      )}

      {(display === 'awaiting' || approval) && s.turn !== 'ended' && (
        <div className={styles.approval}>
          <span className={styles.approvalIcon} aria-hidden="true">
            <Icon icon={Hand} size={20} />
          </span>
          <p className={styles.approvalText}>{t('voice.conversation.states.awaitingHelp')}</p>
          {approval && (
            <Button variant="primary" onClick={() => setReviewing(approval.id)}>
              {t('voice.conversation.review')}
            </Button>
          )}
        </div>
      )}

      {s.error && s.turn !== 'ended' && s.error.source === 'submit' && (
        <ErrorBanner error={s.error.error} />
      )}

      <Captions captions={s.captions} heard={s.heard} interim={s.interim} />

      <div className={styles.settings}>
        {micUsable && (
          <Select
            label={t('voice.language')}
            size="sm"
            value={lang}
            onChange={(e) => changeLanguage(e.target.value as SpeechLocale)}
            fieldClassName={styles.language}
            disabled={s.turn === 'ended'}
          >
            {SPEECH_LOCALES.map((l) => (
              <option key={l} value={l} lang={localeFromSpeech(l)}>
                {t(`voice.languages.${LANGUAGE_KEY[l]}`)}
              </option>
            ))}
          </Select>
        )}
        <p className={styles.note}>{t('voice.conversation.privacy')}</p>
        <p className={cx(styles.note, styles.keyboard)} id={keyboardHintId}>
          {t('voice.conversation.keyboard', { stop: stopPhrase ?? 'stop' })}
        </p>
      </div>

      {/* Always in view: the text field (the fallback at any time) and the controls. */}
      <div className={styles.actions}>
        <form className={styles.input} onSubmit={sendTyped}>
          <label htmlFor={inputId} className="visually-hidden">
            {t('voice.conversation.input.label')}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            className={styles.field}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('voice.conversation.input.placeholder')}
            maxLength={MAX_REQUEST + 200}
            dir={text ? 'auto' : undefined}
            enterKeyHint="send"
            autoComplete="off"
            aria-invalid={tooLong || undefined}
            disabled={s.turn === 'ended'}
          />
          <IconButton
            type="submit"
            label={t('voice.conversation.input.send')}
            icon={ArrowUp}
            variant="primary"
            shape="round"
            size="sm"
            disabled={!text.trim() || tooLong || s.turn === 'ended' || busySending}
          />
        </form>
        {tooLong && (
          <p className={styles.tooLong} role="status">
            {t('composer.tooLong', { count: text.length - MAX_REQUEST })}
          </p>
        )}
        <div className={styles.controls}>
          <Button
            variant="secondary"
            icon={PhoneOff}
            onClick={() => controller?.end('end_button')}
            disabled={s.turn === 'ended'}
          >
            {t('voice.conversation.end')}
          </Button>
          <div className={styles.actionsEnd}>
            {onTypeInstead && (
              <Button
                variant="ghost"
                icon={Keyboard}
                className={styles.typeInstead}
                onClick={() => {
                  onTypeInstead(text);
                  controller?.end('switched_to_text');
                }}
              >
                {t('voice.typeInstead')}
              </Button>
            )}
            {micUsable && (
              <Button
                variant={micOn ? 'secondary' : 'primary'}
                icon={micOn ? MicOff : Mic}
                onClick={() => controller?.toggleMic()}
                disabled={s.turn === 'ended'}
                aria-describedby={keyboardHintId}
              >
                {s.turn === 'failed' ||
                s.mic === 'error' ||
                s.mic === 'denied' ||
                s.mic === 'no-mic'
                  ? t('voice.conversation.listenAgain')
                  : micOn
                    ? t('voice.conversation.micOff')
                    : t('voice.conversation.micOn')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {approval && (
        <ApprovalSheet
          approval={approval}
          open={reviewing === approval.id}
          onClose={() => setReviewing(null)}
        />
      )}
    </div>
  );
}

/** Everything said, as captions: an ordered log (JARVIS's lines are announced as they come). */
function Captions({
  captions,
  heard,
  interim,
}: {
  captions: readonly Caption[];
  heard: string;
  interim: string;
}) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const live = [heard, interim].filter(Boolean).join(' ');
  // Keep the newest caption in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [captions, live]);
  return (
    <section className={styles.captions} aria-label={t('voice.conversation.captions.label')}>
      {/* Scrollable (and so focusable): the newest caption stays in view. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div className={styles.scroller} ref={scrollRef} role="log" aria-live="polite" tabIndex={0}>
        {captions.length === 0 && !live ? (
          <p className={styles.placeholder}>{t('voice.conversation.captions.empty')}</p>
        ) : (
          <ol className={styles.log}>
            {captions.map((c) => (
              <li key={c.id} className={cx(styles.caption, styles[c.speaker])} data-kind={c.kind}>
                <span className={styles.speaker}>
                  {c.speaker === 'user'
                    ? t('voice.conversation.captions.you')
                    : t('voice.conversation.captions.jarvis')}
                  {c.typed && (
                    <span className={styles.tag}>{t('voice.conversation.captions.typed')}</span>
                  )}
                </span>
                <p className={styles.text} dir="auto" lang={c.lang}>
                  {c.text}
                </p>
                {(c.interrupted || c.unsent || c.assent || (c.speaker === 'user' && c.taskId)) && (
                  <p className={styles.meta}>
                    {c.interrupted && <span>{t('voice.conversation.captions.interrupted')}</span>}
                    {c.unsent && <span>{t('voice.conversation.captions.unsent')}</span>}
                    {c.assent && <span>{t('voice.conversation.captions.assent')}</span>}
                    {c.speaker === 'user' && c.taskId && (
                      <Link href={`/tasks/${c.taskId}`} className={styles.taskLink}>
                        {t('voice.conversation.openTask')}
                      </Link>
                    )}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
      {live && (
        // What the recogniser hears right now (not announced: the final words join the log).
        <p className={styles.hearing} aria-hidden="true">
          <span className={styles.speaker}>{t('voice.conversation.captions.heard')}</span>
          <span dir="auto" className={styles.hearingText}>
            {heard}
            {interim && (
              <>
                {heard ? ' ' : ''}
                <span className={styles.interim}>{interim}</span>
              </>
            )}
          </span>
        </p>
      )}
    </section>
  );
}
