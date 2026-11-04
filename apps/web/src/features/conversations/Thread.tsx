'use client';

import type { MissingInfo, TaskDetail, TaskSummary } from '@jarvis/contracts';
import { isTerminal } from '@jarvis/contracts';
import { ArrowUpRight, MessageCircleQuestionMark, Paperclip } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { FollowUpComposer } from '@/components/composer/CommandComposer';
import type { ComposerHandle } from '@/components/composer/ComposerRegistry';
import { presenceFromTask } from '@/components/presence/model';
import { Presence } from '@/components/presence/Presence';
import { taskTitle } from '@/components/tasks/TaskRow';
import { TaskStatusPill } from '@/components/tasks/TaskStatusPill';
import { Avatar } from '@/components/ui/Avatar';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/Toast';
import { AttachmentList } from '@/features/attachments/Attachments';
import { useI18n } from '@/i18n/I18nProvider';
import { errorLine } from '@/i18n/server-message';
import { useAssistantStatus, useMe } from '@/lib/api/hooks';
import { cx } from '@/lib/cx';
import { useDeleteConversation } from './api';
import { isQuestion, messageText, questionText, type TurnGroup } from './model';
import styles from './Thread.module.css';

/* ------------------------------------------------------------------ turns */

/**
 * One request of a conversation: what the user asked (with its files), then JARVIS — the task's
 * live state as a small Presence ring and status, and what it said when the task completed (its
 * answer, question or result line). The task's title links to its page.
 */
export function TurnItem({
  group,
  position,
  answered = false,
}: {
  group: TurnGroup;
  position: number;
  /** A later request of the conversation follows (a question here was answered). */
  answered?: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const me = useMe();
  const task = group.task;
  const titleId = useId();
  const request = group.request;
  const reply = group.reply ? messageText(i18n, group.reply) : null;
  const asked = task && isQuestion(task);
  const presence = task ? presenceFromTask(task) : null;
  return (
    <li className={styles.turn} aria-labelledby={titleId}>
      <h3 id={titleId} className="visually-hidden">
        {t('conversations.thread.turnLabel', { position })}
      </h3>
      {(request || task) && (
        <div className={styles.message} data-from="user">
          <Avatar name={me.data?.displayName ?? '?'} size={24} className={styles.avatar} />
          <div className={styles.messageBody}>
            <p className={styles.who}>
              <span>{t('conversations.thread.you')}</span>
              {(request?.createdAt ?? task?.createdAt) && (
                <>
                  <span aria-hidden="true">·</span>
                  <RelativeTime value={(request?.createdAt ?? task?.createdAt)!} />
                </>
              )}
            </p>
            <p className={styles.bubble} dir="auto">
              {request?.text ?? task?.request}
            </p>
            {request && request.attachments.length > 0 ? (
              <AttachmentList attachments={request.attachments} compact />
            ) : (
              task?.attachmentCount !== undefined &&
              task.attachmentCount > 0 && (
                <p className={styles.fileCount}>
                  <Icon icon={Paperclip} size={16} />
                  {t('attachments.count', { count: task.attachmentCount })}
                </p>
              )
            )}
          </div>
        </div>
      )}
      {task && (
        <div className={styles.message} data-from="jarvis">
          <span className={styles.avatar}>
            <Presence
              state={asked ? 'idle' : (presence?.state ?? 'idle')}
              progress={presence?.progress}
              size={24}
              label=""
            />
          </span>
          <div className={styles.messageBody}>
            <p className={styles.who}>
              <span>{t('conversations.thread.jarvis')}</span>
            </p>
            <div className={styles.taskLine}>
              <TaskStatusPill status={task.status} outcome={task.outcome} answered={answered} />
              <Link href={`/tasks/${task.id}`} className={styles.taskLink}>
                <span className={styles.taskTitle} dir="auto">
                  {taskTitle(i18n, task)}
                </span>
                <Icon icon={ArrowUpRight} size={16} mirror className={styles.taskLinkIcon} />
              </Link>
            </div>
            {reply ? (
              <div className={cx(styles.reply, asked && styles.replyQuestion)}>
                {asked && (
                  <Icon icon={MessageCircleQuestionMark} size={16} className={styles.replyIcon} />
                )}
                {reply.localized ? (
                  <p className={styles.replyText}>{reply.text}</p>
                ) : (
                  <p className={styles.replyText} dir="auto">
                    {reply.text}
                  </p>
                )}
              </div>
            ) : task.status === 'FAILED' && task.error ? (
              <p className={styles.replyError}>{errorLine(i18n, task.error)}</p>
            ) : null}
          </div>
        </div>
      )}
    </li>
  );
}

/** Turns as an ordered list (positions count from `start`). */
export function TurnList({
  groups,
  start,
  label,
  followed = false,
}: {
  groups: readonly TurnGroup[];
  start: number;
  label: string;
  /** More requests follow the last of these (the page's own task, below them). */
  followed?: boolean;
}) {
  return (
    <ol className={styles.turns} aria-label={label}>
      {groups.map((group, i) => (
        <TurnItem
          key={group.taskId}
          group={group}
          position={start + i}
          answered={followed || i < groups.length - 1}
        />
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ earlier */

const EARLIER_SHOWN = 2;

/**
 * "Earlier in this conversation" above a task: the two most recent earlier requests, and a
 * button for the rest (loading older pages from the server when needed).
 */
export function EarlierTurns({
  groups,
  hasOlderPages,
  loadingOlder,
  onLoadOlder,
}: {
  groups: readonly TurnGroup[];
  hasOlderPages: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();
  if (groups.length === 0 && !hasOlderPages) return null;
  const hidden = expanded ? 0 : Math.max(0, groups.length - EARLIER_SHOWN);
  const shown = groups.slice(hidden);
  const more = hidden > 0 || hasOlderPages;
  return (
    <section className={styles.earlier} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.sectionTitle}>
        {t('conversations.thread.earlierTitle')}
      </h2>
      {more && (
        <Button
          variant="ghost"
          size="sm"
          className={styles.showEarlier}
          loading={loadingOlder}
          onClick={() => {
            if (hidden > 0) setExpanded(true);
            else onLoadOlder();
          }}
        >
          {t('conversations.thread.showEarlier')}
        </Button>
      )}
      <TurnList
        groups={shown}
        start={hidden + 1}
        label={t('conversations.thread.earlierTitle')}
        followed
      />
    </section>
  );
}

/* ------------------------------------------------------------------ question */

/**
 * JARVIS asked instead of guessing: the question, in JARVIS's voice and a neutral tone (nothing
 * failed and nothing was done), with the answer field right under it. `missing: document`
 * offers the file picker as a labelled button.
 */
export function QuestionPanel({
  task,
  composer,
  answered,
  missing,
}: {
  task: Pick<TaskDetail, 'question' | 'resultSummary'>;
  /** The answer field, when this is the latest request of the conversation. */
  composer: ReactNode;
  answered: boolean;
  missing: readonly MissingInfo[];
}) {
  const i18n = useI18n();
  const { t, f } = i18n;
  const headingId = useId();
  const question = questionText(i18n, task.question, task.resultSummary);
  return (
    <section className={styles.question} aria-labelledby={headingId}>
      <div className={styles.questionHead}>
        <span className={styles.questionIcon} aria-hidden="true">
          <Icon icon={MessageCircleQuestionMark} size={20} />
        </span>
        <div className={styles.questionText}>
          <h2 id={headingId} className={styles.questionTitle}>
            {t('conversations.question.title')}
          </h2>
          {question &&
            (task.question?.message ? (
              <p className={styles.questionBody}>{question}</p>
            ) : (
              <p className={styles.questionBody} dir="auto">
                {question}
              </p>
            ))}
          {missing.length > 0 && (
            <p className={styles.questionMissing}>
              {t('tasks.evidence.questionMissing', {
                list: f.list(missing.map((m) => t(`conversations.question.missing.${m}`))),
              })}
            </p>
          )}
        </div>
      </div>
      {answered ? (
        <p className={styles.questionNote}>{t('conversations.question.answered')}</p>
      ) : (
        <>
          <p className={styles.questionNote}>{t('conversations.question.hint')}</p>
          {composer}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ continuation */

/**
 * After a task's result: the requests sent since then (live), and the follow-up field. While a
 * task of the conversation is active the field says what it waits for, and links to it.
 */
export function ConversationContinuation({
  conversationId,
  currentTaskId,
  later,
  startPosition,
  canFollowUp,
  activeTask,
  showComposer,
  loadError,
  onRetry,
}: {
  conversationId: string;
  currentTaskId: string;
  later: readonly TurnGroup[];
  startPosition: number;
  canFollowUp: boolean;
  activeTask: Pick<TaskSummary, 'id' | 'status'> | null;
  showComposer: boolean;
  loadError: unknown;
  onRetry: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const headingId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const sentTaskId = useRef<string | null>(null);

  // A sent follow-up appears in the thread once the conversation refreshes: bring it into view.
  useEffect(() => {
    const id = sentTaskId.current;
    if (!id || !later.some((g) => g.taskId === id)) return;
    sentTaskId.current = null;
    const link = listRef.current?.querySelector<HTMLElement>(`a[href="/tasks/${id}"]`);
    link?.closest('li')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [later]);

  if (later.length === 0 && !showComposer && !loadError) return null;
  // The active request is always the newest one (follow-ups wait for it), shown just above.
  const awaiting = activeTask?.status === 'AWAITING_APPROVAL';
  const blocked = canFollowUp ? null : activeTask && activeTask.id !== currentTaskId ? (
    <>
      {awaiting ? t('conversations.followUp.busyApproval') : t('conversations.followUp.busy')}{' '}
      <Link href={`/tasks/${activeTask.id}`}>
        {awaiting ? t('conversations.followUp.reviewBusy') : t('conversations.followUp.openBusy')}
      </Link>
    </>
  ) : (
    t('conversations.followUp.busyGeneric')
  );

  return (
    <section className={styles.continuation} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.sectionTitle}>
        {later.length > 0
          ? t('conversations.thread.laterTitle')
          : t('conversations.followUp.title')}
      </h2>
      {loadError !== null && loadError !== undefined && (
        <ErrorBanner
          title={t('conversations.thread.loadError')}
          error={loadError}
          onRetry={onRetry}
        />
      )}
      {later.length > 0 && (
        <div ref={listRef}>
          <TurnList
            groups={later}
            start={startPosition}
            label={t('conversations.thread.laterTitle')}
          />
        </div>
      )}
      {showComposer && (
        <div className={styles.followUp}>
          {later.length === 0 && (
            <p className={styles.followUpHint}>{t('conversations.followUp.hint')}</p>
          )}
          <FollowUpComposer
            conversationId={conversationId}
            blocked={blocked}
            onSent={(task) => {
              sentTaskId.current = task.id;
            }}
          />
        </div>
      )}
    </section>
  );
}

/** The answer field for a question (the follow-up composer, focused, files on request). */
export function AnswerComposer({
  conversationId,
  missing,
  onSent,
}: {
  conversationId: string;
  missing: readonly MissingInfo[];
  onSent?: (task: TaskSummary) => void;
}) {
  const { t } = useI18n();
  const status = useAssistantStatus();
  const handle = useRef<ComposerHandle>(null);
  const wantsFile = missing.includes('document');
  // The file picker only where this server stores files; otherwise say so (no dead button).
  const canAttach = status.data?.capabilities.attachments === true;
  return (
    <div className={styles.answer}>
      {wantsFile &&
        (canAttach ? (
          <div>
            <Button size="sm" icon={Paperclip} onClick={() => handle.current?.attach?.()}>
              {t('conversations.question.attach')}
            </Button>
          </div>
        ) : (
          status.data && <p className={styles.answerNote}>{t('attachments.unavailable')}</p>
        ))}
      <FollowUpComposer
        conversationId={conversationId}
        answering
        focusOnMount
        handleRef={handle}
        onSent={onSent}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ delete */

/** Deletes the whole conversation (all its tasks and files) after a confirmation. */
export function DeleteConversation({
  conversationId,
  taskCount,
  scheduled,
}: {
  conversationId: string;
  taskCount: number;
  scheduled: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const remove = useDeleteConversation(conversationId);
  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setOpen(true)} className={styles.delete}>
        {t('conversations.delete.button')}
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          if (!remove.isPending) setOpen(false);
        }}
        title={t('conversations.delete.title')}
        description={t('conversations.delete.body', { count: Math.max(1, taskCount) })}
        dismissible={!remove.isPending}
        busy={remove.isPending}
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={remove.isPending}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    toast({ message: t('conversations.delete.deleted') });
                    router.push('/tasks/conversations');
                  },
                })
              }
            >
              {t('conversations.delete.confirm')}
            </Button>
          </>
        }
      >
        {scheduled && <p className={styles.dialogNote}>{t('conversations.delete.scheduleNote')}</p>}
        {remove.isError && <ErrorBanner error={remove.error} />}
      </Dialog>
    </>
  );
}

/** Whether a conversation's newest task still runs (from the loaded turns). */
export function activeTaskOf(groups: readonly TurnGroup[]): TaskSummary | null {
  for (let i = groups.length - 1; i >= 0; i--) {
    const task = groups[i]!.task;
    if (task && !isTerminal(task.status)) return task;
  }
  return null;
}
