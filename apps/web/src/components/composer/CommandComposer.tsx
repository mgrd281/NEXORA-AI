'use client';

import type { AssistantStatus, TaskSummary } from '@jarvis/contracts';
import { ArrowUp, Info, Mic } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { ErrorBanner } from '@/components/ui/Banner';
import { IconButton } from '@/components/ui/Button';
import { autoGrow } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { Kbd } from '@/components/ui/Kbd';
import { useToast } from '@/components/ui/Toast';
import { VoiceMode } from '@/components/voice/VoiceMode';
import { useI18n } from '@/i18n/I18nProvider';
import { newIdempotencyKey } from '@/lib/api/client';
import { useAssistantStatus, useCreateTask } from '@/lib/api/hooks';
import { cx } from '@/lib/cx';
import styles from './CommandComposer.module.css';
import { useComposerRegistry, type ComposerHandle } from './ComposerRegistry';

const MAX_REQUEST = 4000;
const SHOW_COUNT_FROM = 3600;
const MAX_ROWS = 8;

export interface CommandComposerProps {
  /** Called with the created task instead of opening it. */
  onCreated?: (task: TaskSummary) => void;
  /** Make this the target of ⌘/Ctrl+K and '/' (default true; use one per screen). */
  shortcutTarget?: boolean;
  autoFocus?: boolean;
  className?: string;
  /** Imperative focus / setText (e.g. for suggestions). */
  handleRef?: Ref<ComposerHandle>;
}

/**
 * "Ask JARVIS to do something…": an auto-growing request field. Enter sends, Shift+Enter adds a
 * line, the mic opens voice mode. Each submission is POSTed once with its own Idempotency-Key
 * (reused if the same text is retried after an error). While the planner is offline, a quiet
 * hint lists what works without an AI model.
 */
export function CommandComposer({
  onCreated,
  shortcutTarget = true,
  autoFocus = false,
  className,
  handleRef,
}: CommandComposerProps) {
  const { t } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const registry = useComposerRegistry();
  const status = useAssistantStatus();
  const createTask = useCreateTask();
  const [text, setText] = useState('');
  const [voiceOpen, setVoiceOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const keyFor = useRef<{ text: string; key: string } | null>(null);
  const inputId = useId();
  const hintId = useId();
  const countId = useId();

  const trimmed = text.trim();
  const over = text.length - MAX_REQUEST;
  const submitting = createTask.isPending;
  const canSubmit = trimmed !== '' && over <= 0 && !submitting;

  useEffect(() => {
    if (textareaRef.current) autoGrow(textareaRef.current, MAX_ROWS);
  }, [text]);

  const handle = useCallback<() => ComposerHandle>(
    () => ({
      focus: () => textareaRef.current?.focus(),
      setText: (value: string) => {
        setText(value);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(value.length, value.length);
        });
      },
    }),
    [],
  );
  useImperativeHandle(handleRef, handle, [handle]);
  useEffect(() => {
    if (!shortcutTarget || !registry) return;
    return registry.register(handle());
  }, [shortcutTarget, registry, handle]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    // Same text after a failed attempt → same key, so the API never creates it twice.
    if (!keyFor.current || keyFor.current.text !== trimmed) {
      keyFor.current = { text: trimmed, key: newIdempotencyKey() };
    }
    try {
      const task = await createTask.mutateAsync({
        body: { request: trimmed, source: 'text' },
        idempotencyKey: keyFor.current.key,
      });
      keyFor.current = null;
      setText('');
      const workerDown = status.data?.worker.healthy === false;
      toast({ message: workerDown ? t('composer.queued') : t('composer.sent') });
      if (onCreated) onCreated(task);
      else router.push(`/tasks/${task.id}`);
    } catch {
      // Shown inline by the error banner below; focus stays in the field.
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const describedBy = [hintId, text.length >= SHOW_COUNT_FROM ? countId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cx(styles.root, className)}>
      <form
        className={styles.form}
        onSubmit={(e) => void submit(e)}
        aria-busy={submitting || undefined}
      >
        <label htmlFor={inputId} className="visually-hidden">
          {t('composer.label')}
        </label>
        <div className={styles.box}>
          <textarea
            ref={textareaRef}
            id={inputId}
            className={styles.input}
            rows={1}
            value={text}
            placeholder={t('composer.placeholder')}
            onChange={(e) => {
              setText(e.target.value);
              if (createTask.isError) createTask.reset();
            }}
            onKeyDown={onKeyDown}
            aria-describedby={describedBy || undefined}
            aria-invalid={over > 0 || undefined}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- only when a screen opts in
            autoFocus={autoFocus}
            // Empty: follow the page (placeholder aligns to the start); typed: follow the text.
            dir={text ? 'auto' : undefined}
            enterKeyHint="send"
            spellCheck
          />
          <div className={styles.actions}>
            <IconButton
              label={t('composer.voice')}
              icon={Mic}
              onClick={() => setVoiceOpen(true)}
              disabled={submitting}
            />
            <IconButton
              type="submit"
              label={submitting ? t('composer.sending') : t('composer.send')}
              icon={ArrowUp}
              variant="primary"
              shape="round"
              size="sm"
              disabled={!canSubmit && !submitting}
              loading={submitting}
              className={styles.send}
            />
          </div>
        </div>
        <div className={styles.below}>
          <p id={hintId} className={styles.hint}>
            <Kbd>{t('composer.keyEnter')}</Kbd> {t('composer.hintSend')}
            <span className={styles.dot} aria-hidden="true">
              ·
            </span>
            <Kbd>{t('composer.keyShift')}</Kbd>
            <span aria-hidden="true">+</span>
            <Kbd>{t('composer.keyEnter')}</Kbd> {t('composer.hintNewLine')}
          </p>
          {text.length >= SHOW_COUNT_FROM && (
            <p
              id={countId}
              className={cx(styles.count, over > 0 && styles.countOver, 'tabular')}
              aria-live="polite"
            >
              {over > 0
                ? t('composer.tooLong', { count: over })
                : t('composer.characterCount', { count: text.length, max: MAX_REQUEST })}
            </p>
          )}
        </div>
        {createTask.isError && (
          <ErrorBanner
            error={createTask.error}
            onRetry={canSubmit ? () => void submit() : undefined}
            className={styles.error}
          />
        )}
      </form>
      {status.data?.planner.mode === 'offline' && <OfflineHint status={status.data} />}
      <VoiceMode
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        onCreated={onCreated}
        onTypeInstead={(transcript) => {
          if (transcript) handle().setText(transcript);
          else requestAnimationFrame(() => textareaRef.current?.focus());
        }}
      />
    </div>
  );
}

/** What the deterministic offline planner understands, given the live capabilities. */
function OfflineHint({ status }: { status: AssistantStatus }) {
  const { t } = useI18n();
  const caps = status.capabilities;
  const items = [
    {
      text: t('composer.offline.summarize'),
      missing: caps.webFetch ? null : t('composer.offline.needsWeb'),
    },
    {
      text: t('composer.offline.remember'),
      missing: caps.memory ? null : t('composer.offline.memoryOff'),
    },
    {
      text: t('composer.offline.emailMe'),
      missing: caps.email ? null : t('composer.offline.needsEmail'),
    },
  ];
  return (
    <aside className={styles.offline} aria-label={t('composer.offline.title')}>
      <Icon icon={Info} size={16} className={styles.offlineIcon} />
      <div className={styles.offlineBody}>
        <p className={styles.offlineLead}>
          <strong className={styles.offlineTitle}>{t('composer.offline.title')}</strong>{' '}
          {t('composer.offline.body')}
        </p>
        <ul className={styles.offlineList}>
          {items.map((item) => (
            <li key={item.text}>
              <span className={styles.command}>{item.text}</span>
              {item.missing && <span className={styles.missing}> — {item.missing}</span>}
            </li>
          ))}
        </ul>
        <Link href="/settings#assistant" className={styles.offlineLink}>
          {t('composer.offline.settingsLink')}
        </Link>
      </div>
    </aside>
  );
}
