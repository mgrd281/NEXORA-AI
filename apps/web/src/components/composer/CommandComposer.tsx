'use client';

import type { AssistantStatus, CreateTaskRequest, TaskSummary } from '@jarvis/contracts';
import { ATTACHMENT_LIMITS } from '@jarvis/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ChevronRight, Mic } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { ErrorBanner } from '@/components/ui/Banner';
import { IconButton } from '@/components/ui/Button';
import { autoGrow } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { Kbd } from '@/components/ui/Kbd';
import { useToast } from '@/components/ui/Toast';
import { VoiceMode } from '@/components/voice/VoiceMode';
import {
  AttachButton,
  AttachmentAnnouncer,
  AttachmentTray,
  type AttachButtonHandle,
} from '@/features/attachments/Attachments';
import { LIMIT_MB } from '@/features/attachments/files';
import { filesFromPaste, useAttachmentDraft } from '@/features/attachments/useAttachmentDraft';
import { useI18n } from '@/i18n/I18nProvider';
import { stripIsolates, templateWithSlot } from '@/i18n/translate';
import { api, newIdempotencyKey, type ApiError } from '@/lib/api/client';
import { useAssistantStatus } from '@/lib/api/hooks';
import { qk } from '@/lib/api/query-keys';
import { cx } from '@/lib/cx';
import styles from './CommandComposer.module.css';
import { useComposerRegistry, type ComposerHandle } from './ComposerRegistry';

const MAX_REQUEST = 4000;
const SHOW_COUNT_FROM = 3600;
const MAX_ROWS = 8;

/** Sends one request (a new task or a follow-up) with its Idempotency-Key. */
export type SubmitRequest = (
  body: CreateTaskRequest,
  idempotencyKey: string,
) => Promise<TaskSummary>;

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
 * line, the mic opens voice mode, the paperclip (or dropping / pasting files) attaches
 * documents when this server stores files. Each submission is POSTed once with its own
 * Idempotency-Key (reused if the same text and files are retried after an error). In basic mode
 * (no AI model) one quiet line under the field offers the requests that work, each as a chip
 * that fills in a template with its slot selected.
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
  const queryClient = useQueryClient();
  const status = useAssistantStatus();
  // The form's handle, for the basic-mode templates; the caller's handle forwards to it.
  const own = useRef<ComposerHandle | null>(null);
  useImperativeHandle(
    handleRef,
    () => ({
      focus: () => own.current?.focus(),
      setText: (text, selection) => own.current?.setText(text, selection),
      attach: () => own.current?.attach?.(),
    }),
    [],
  );
  const submit = useCallback<SubmitRequest>(
    async (body, idempotencyKey) => {
      const task = await api.call('createTask', { body, idempotencyKey });
      void queryClient.invalidateQueries({ queryKey: qk.tasks.lists });
      void queryClient.invalidateQueries({ queryKey: qk.home });
      void queryClient.invalidateQueries({ queryKey: qk.conversations.lists });
      return task;
    },
    [queryClient],
  );
  return (
    <ComposerForm
      submit={submit}
      label={t('composer.label')}
      placeholder={t('composer.placeholder')}
      sendLabel={t('composer.send')}
      sentMessage={(workerDown) => (workerDown ? t('composer.queued') : t('composer.sent'))}
      onCreated={(task) => {
        if (onCreated) onCreated(task);
        else router.push(`/tasks/${task.id}`);
      }}
      shortcutTarget={shortcutTarget}
      focusOnMount={autoFocus}
      className={className}
      handleRef={own}
      after={
        status.data?.planner.mode === 'offline' ? (
          <BasicModeLine
            status={status.data}
            onTemplate={(raw) => {
              const { text: value, start, end } = templateWithSlot(raw);
              own.current?.setText(value, { start, end });
            }}
          />
        ) : null
      }
    />
  );
}

export interface FollowUpComposerProps {
  conversationId: string;
  /** Why a follow-up can't be sent yet (a task of the conversation is still active). */
  blocked?: ReactNode;
  /** Answering a clarifying question: different placeholder, files offered prominently. */
  answering?: boolean;
  /** Focus the field when it appears (the answer to a question JARVIS just asked). */
  focusOnMount?: boolean;
  onSent?: (task: TaskSummary) => void;
  handleRef?: Ref<ComposerHandle>;
  className?: string;
}

/**
 * The reply field at the end of a conversation: same behaviour as the command composer (Enter
 * sends, voice, files), but it sends POST /v1/conversations/:id/messages, so the new task is
 * planned with the conversation's earlier turns. The thread shows the new task as it arrives.
 */
export function FollowUpComposer({
  conversationId,
  blocked,
  answering = false,
  focusOnMount,
  onSent,
  handleRef,
  className,
}: FollowUpComposerProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const submit = useCallback<SubmitRequest>(
    async (body, idempotencyKey) => {
      const task = await api.call('followUp', {
        params: { id: conversationId },
        body,
        idempotencyKey,
      });
      void queryClient.invalidateQueries({ queryKey: qk.conversations.all });
      void queryClient.invalidateQueries({ queryKey: qk.tasks.lists });
      void queryClient.invalidateQueries({ queryKey: qk.home });
      return task;
    },
    [conversationId, queryClient],
  );
  return (
    <ComposerForm
      submit={submit}
      label={
        answering ? t('conversations.question.answerLabel') : t('conversations.followUp.label')
      }
      placeholder={
        answering
          ? t('conversations.followUp.answerPlaceholder')
          : t('conversations.followUp.placeholder')
      }
      sendLabel={t('conversations.followUp.send')}
      sentMessage={() => t('conversations.followUp.sent')}
      onCreated={(task) => onSent?.(task)}
      conversationId={conversationId}
      shortcutTarget={false}
      focusOnMount={focusOnMount}
      blocked={blocked}
      handleRef={handleRef}
      className={className}
    />
  );
}

interface ComposerFormProps {
  submit: SubmitRequest;
  label: string;
  placeholder: string;
  sendLabel: string;
  sentMessage: (workerDown: boolean) => string;
  onCreated: (task: TaskSummary) => void;
  shortcutTarget: boolean;
  focusOnMount?: boolean;
  blocked?: ReactNode;
  className?: string;
  handleRef?: Ref<ComposerHandle>;
  /** Content under the form (the basic-mode line). */
  after?: ReactNode;
  /** The conversation this field continues (a voice conversation continues it too). */
  conversationId?: string;
}

type Notice = 'waitForUploads' | 'removeFailed' | null;

function ComposerForm({
  submit,
  label,
  placeholder,
  sendLabel,
  sentMessage,
  onCreated,
  shortcutTarget,
  focusOnMount = false,
  blocked,
  className,
  handleRef,
  after,
  conversationId,
}: ComposerFormProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const registry = useComposerRegistry();
  const status = useAssistantStatus();
  const draft = useAttachmentDraft();
  const send = useMutation<TaskSummary, ApiError, { body: CreateTaskRequest; key: string }>({
    mutationFn: ({ body, key }) => submit(body, key),
  });
  const [text, setText] = useState('');
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachRef = useRef<AttachButtonHandle>(null);
  const dragDepth = useRef(0);
  const keyFor = useRef<{ intent: string; key: string } | null>(null);
  const inputId = useId();
  const hintId = useId();
  const countId = useId();
  const blockedId = useId();
  const noticeId = useId();

  // Files only where the server stores them (capability), never on an older server.
  const canAttach = status.data?.capabilities.attachments === true;
  const trimmed = text.trim();
  const over = text.length - MAX_REQUEST;
  const submitting = send.isPending;
  const canSubmit = trimmed !== '' && over <= 0 && !submitting && !blocked;

  useEffect(() => {
    if (textareaRef.current) autoGrow(textareaRef.current, MAX_ROWS);
  }, [text]);
  // A notice about files goes away once the files it was about are sorted out.
  const shownNotice: Notice =
    (notice === 'waitForUploads' && draft.uploading) ||
    (notice === 'removeFailed' && draft.hasErrors)
      ? notice
      : null;

  const handle = useCallback<() => ComposerHandle>(
    () => ({
      focus: () => textareaRef.current?.focus(),
      setText: (raw: string, selection?: { start: number; end: number }) => {
        // Translated templates carry bidi isolation marks; request text never should.
        const value = stripIsolates(raw);
        setText(value);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          if (selection) el.setSelectionRange(selection.start, selection.end);
          else el.setSelectionRange(value.length, value.length);
        });
      },
      attach: () => attachRef.current?.open(),
    }),
    [],
  );
  useImperativeHandle(handleRef, handle, [handle]);
  useEffect(() => {
    if (!shortcutTarget || !registry) return;
    return registry.register(handle());
  }, [shortcutTarget, registry, handle]);

  /** Sends the request (typed or dictated) with the files that finished uploading. */
  const sendRequest = async (
    body: Omit<CreateTaskRequest, 'attachmentIds' | 'source'> & { source: 'text' | 'voice' },
  ): Promise<TaskSummary> => {
    const ids = draft.ids;
    const intent = `${body.request}\u0000${ids.join(',')}`;
    // Same text and files after a failed attempt → same key, so the API never creates it twice.
    if (!keyFor.current || keyFor.current.intent !== intent) {
      keyFor.current = { intent, key: newIdempotencyKey() };
    }
    const task = await send.mutateAsync({
      body: { ...body, ...(ids.length > 0 ? { attachmentIds: ids } : {}) },
      key: keyFor.current.key,
    });
    keyFor.current = null;
    draft.clear();
    return task;
  };

  const filesReady = (): boolean => {
    if (draft.uploading) {
      setNotice('waitForUploads');
      return false;
    }
    if (draft.hasErrors) {
      setNotice('removeFailed');
      return false;
    }
    return true;
  };

  const submitTyped = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSubmit || !filesReady()) return;
    try {
      const task = await sendRequest({ request: trimmed, source: 'text' });
      setText('');
      toast({ message: sentMessage(status.data?.worker.healthy === false) });
      onCreated(task);
    } catch {
      // Shown inline by the error banner below; focus stays in the field.
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submitTyped();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!canAttach) return;
    const { files, keepText } = filesFromPaste(e.clipboardData);
    if (files.length > 0) draft.add(files);
    if (!keepText) e.preventDefault();
  };

  const hasFiles = (e: DragEvent) => canAttach && [...e.dataTransfer.types].includes('Files');
  const dropHandlers = {
    onDragEnter: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      draft.add([...e.dataTransfer.files]);
      textareaRef.current?.focus();
    },
  };

  const showCount = text.length >= SHOW_COUNT_FROM;
  const describedBy = [
    hintId,
    showCount ? countId : null,
    blocked ? blockedId : null,
    shownNotice ? noticeId : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cx(styles.root, className)}>
      {blocked && (
        <p id={blockedId} className={styles.blocked}>
          {blocked}
        </p>
      )}
      <form
        className={styles.form}
        onSubmit={(e) => void submitTyped(e)}
        aria-busy={submitting || undefined}
      >
        <label htmlFor={inputId} className="visually-hidden">
          {label}
        </label>
        <div className={styles.box} data-dragging={dragging || undefined} {...dropHandlers}>
          {(draft.items.length > 0 || draft.overflow) && (
            <div className={styles.files}>
              <AttachmentTray draft={draft} />
            </div>
          )}
          <div className={styles.row}>
            <textarea
              ref={textareaRef}
              id={inputId}
              className={styles.input}
              rows={1}
              value={text}
              placeholder={placeholder}
              onChange={(e) => {
                setText(e.target.value);
                if (send.isError) send.reset();
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              aria-describedby={describedBy || undefined}
              aria-invalid={over > 0 || undefined}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- only when a screen opts in
              autoFocus={focusOnMount}
              // Empty: follow the page (placeholder aligns to the start); typed: follow the text.
              dir={text ? 'auto' : undefined}
              enterKeyHint="send"
              spellCheck
            />
            {/* Shown while the field is focused and empty; always the field's description. */}
            <p
              id={hintId}
              className={cx(styles.hint, !(focused && text === '') && 'visually-hidden')}
            >
              <Kbd>{t('composer.keyEnter')}</Kbd> {t('composer.hintSend')}
              <span className={styles.dot} aria-hidden="true">
                ·
              </span>
              <Kbd>{t('composer.keyShift')}</Kbd>
              <span aria-hidden="true">+</span>
              <Kbd>{t('composer.keyEnter')}</Kbd> {t('composer.hintNewLine')}
            </p>
            <div className={styles.actions}>
              {canAttach && (
                <AttachButton
                  ref={attachRef}
                  onFiles={(files) => draft.add(files)}
                  disabled={submitting || draft.items.length >= ATTACHMENT_LIMITS.maxPerRequest}
                />
              )}
              <IconButton
                label={t('composer.voice')}
                icon={Mic}
                onClick={() => setVoiceOpen(true)}
                // A dictated request goes out at once: files must be ready (or removed) first.
                disabled={submitting || Boolean(blocked) || draft.uploading || draft.hasErrors}
              />
              <IconButton
                type="submit"
                label={submitting ? t('composer.sending') : sendLabel}
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
          {dragging && (
            <div className={styles.drop} aria-hidden="true">
              <span className={styles.dropTitle}>{t('attachments.dropHere')}</span>
              <span className={styles.dropHint}>
                {t('attachments.dropHint', {
                  max: ATTACHMENT_LIMITS.maxPerRequest,
                  limitMb: LIMIT_MB,
                })}
              </span>
            </div>
          )}
        </div>
        <AttachmentAnnouncer draft={draft} />
        {shownNotice && (
          <p id={noticeId} className={styles.notice} role="status">
            {t(`attachments.${shownNotice}`)}
          </p>
        )}
        {showCount && (
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
        {send.isError && (
          <ErrorBanner
            error={send.error}
            onRetry={canSubmit ? () => void submitTyped() : undefined}
            className={styles.error}
          />
        )}
      </form>
      {after}
      <VoiceMode
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        conversationId={conversationId ?? null}
        submit={sendRequest}
        sentMessage={sentMessage(status.data?.worker.healthy === false)}
        onCreated={onCreated}
        onTypeInstead={(transcript) => {
          if (transcript) handle().setText(transcript);
          else requestAnimationFrame(() => textareaRef.current?.focus());
        }}
      />
    </div>
  );
}

type BasicCapability = 'summarize' | 'remember' | 'emailMe';

/**
 * Basic mode (the deterministic planner, no AI model): one quiet line under the composer with
 * the requests that work. Each is a chip that fills in a template with its slot selected, so
 * typing or pasting replaces it. A capability that is off stays visible, disabled, with why.
 */
function BasicModeLine({
  status,
  onTemplate,
}: {
  status: AssistantStatus;
  onTemplate: (template: string) => void;
}) {
  const { t } = useI18n();
  const caps = status.capabilities;
  const items: Array<{ key: BasicCapability; template: string; missing: string | null }> = [
    {
      key: 'summarize',
      template: t('composer.offline.templates.summarize', {
        slot: t('composer.offline.slots.link'),
      }),
      missing: caps.webFetch ? null : t('composer.offline.needsWeb'),
    },
    {
      key: 'remember',
      template: t('composer.offline.templates.remember', {
        slot: t('composer.offline.slots.something'),
      }),
      missing: caps.memory ? null : t('composer.offline.memoryOff'),
    },
    {
      key: 'emailMe',
      template: t('composer.offline.templates.emailMe', {
        slot: t('composer.offline.slots.text'),
      }),
      missing: caps.email ? null : t('composer.offline.needsEmail'),
    },
  ];
  return (
    <aside className={styles.basic} aria-label={t('composer.offline.title')}>
      <p className="visually-hidden">{t('composer.offline.body')}</p>
      {/* The mode is also the way to learn about it: Settings › Assistant explains why. */}
      <Link
        href="/settings#assistant"
        className={styles.basicMode}
        aria-label={t('composer.offline.settingsLink')}
      >
        <span className={styles.basicDot} aria-hidden="true" />
        {t('composer.offline.title')}
        <Icon icon={ChevronRight} size={16} mirror className={styles.basicChevron} />
      </Link>
      {/* role="list": display: contents must not drop the list semantics. */}
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
      <ul className={styles.basicList} role="list">
        {items.map((item) => (
          <li key={item.key} className={styles.basicItem}>
            <button
              type="button"
              className={styles.chip}
              disabled={item.missing !== null}
              onClick={() => onTemplate(item.template)}
              title={item.missing ? undefined : t('composer.offline.fills')}
            >
              {t(`composer.offline.${item.key}`)}
            </button>
            {item.missing && <span className={styles.missing}>{item.missing}</span>}
          </li>
        ))}
      </ul>
    </aside>
  );
}
