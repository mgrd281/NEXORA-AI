'use client';

import type { TaskDetail } from '@jarvis/contracts';
import { PenLine, RotateCcw, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useComposerRegistry } from '@/components/composer/ComposerRegistry';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/i18n/I18nProvider';
import { serverText } from '@/i18n/server-message';
import { isApiError, type ApiError } from '@/lib/api/client';
import { useCancelTask, useRetryTask } from './api';
import { attemptOf, failedStep, nextAction, requiresAcknowledgement } from './model';
import { hasNextStep } from './phase-c/NextStep';
import styles from './TaskDetail.module.css';

export interface TaskActionsView {
  /** "Cancel task" (with a confirmation), when the server allows it. */
  cancel: ReactNode;
  /**
   * What helps after the task ended: Retry (with an explicit acknowledgement when the last attempt
   * ended with OUTCOME_UNKNOWN, because the action may already have happened), or "Ask again"
   * when retrying would fail the same way (blocked address, a request the offline planner can't
   * plan): the request goes back into the composer on Home to be changed.
   */
  next: ReactNode;
  /** The confirmation dialogs; render once, even when the buttons are gone. */
  dialogs: ReactNode;
}

/**
 * The task's actions as separate pieces, so the screen can place them: the decision comes first
 * while an approval is pending, and Cancel moves out of the header. Errors are reported to the
 * screen; focus moves to `focusAfter` once the button that was used disappears.
 */
export function useTaskActions({
  task,
  focusAfter,
  onError,
  cancelVariant = 'secondary',
}: {
  task: TaskDetail;
  focusAfter: RefObject<HTMLElement | null>;
  onError: (error: ApiError | null) => void;
  cancelVariant?: 'secondary' | 'ghost';
}): TaskActionsView {
  const i18n = useI18n();
  const { t } = i18n;
  const { toast } = useToast();
  const registry = useComposerRegistry();
  const cancel = useCancelTask(task.id);
  const retry = useRetryTask(task.id, attemptOf(task));
  const [cancelOpen, setCancelOpen] = useState(false);
  const [ackOpen, setAckOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const ackId = useId();
  const needsAck = requiresAcknowledgement(task);
  const waiting = task.status === 'QUEUED' || task.status === 'AWAITING_APPROVAL';

  // Focus moves once no dialog is open any more: while a modal is open the page behind it is
  // inert and cannot take focus. This effect runs after the Dialog's own close effect.
  const focusPending = useRef(false);
  useEffect(() => {
    if (!focusPending.current || cancelOpen || ackOpen) return;
    focusPending.current = false;
    focusAfter.current?.focus();
  });
  const moveFocus = () => {
    focusPending.current = true;
  };

  const confirmCancel = () => {
    onError(null);
    cancel.mutate(undefined, {
      onSuccess: (summary) => {
        setCancelOpen(false);
        toast({
          message:
            summary.status === 'CANCELLED'
              ? t('tasks.actions.cancelled')
              : t('tasks.actions.cancelRequested'),
        });
        moveFocus();
      },
      onError: (error) => {
        // The dialog shows the error; INVALID_STATE means the task moved on: close and show it.
        if (isApiError(error, 'INVALID_STATE')) {
          setCancelOpen(false);
          onError(error);
        }
      },
    });
  };

  const sendRetry = (acknowledgeUnknownOutcome: boolean) => {
    onError(null);
    retry.mutate(
      { acknowledgeUnknownOutcome },
      {
        onSuccess: () => {
          setAckOpen(false);
          setAcknowledged(false);
          toast({ message: t('tasks.actions.retried') });
          moveFocus();
        },
        onError: (error) => {
          // The server asks for the acknowledgement (outcome unknown): show the dialog.
          if (
            isApiError(error, 'INVALID_STATE') &&
            error.details?.requiresAcknowledgement === true &&
            !acknowledgeUnknownOutcome
          ) {
            retry.reset();
            setAckOpen(true);
            return;
          }
          if (!ackOpen) onError(error);
        },
      },
    );
  };

  const onRetryClick = () => {
    if (needsAck) {
      retry.reset();
      setAcknowledged(false);
      setAckOpen(true);
    } else {
      sendRetry(false);
    }
  };

  const step = failedStep(task);
  const action = nextAction(task);
  const fixKind = hasNextStep(task.error);
  // A retry that would be refused the same way is never the emphasised action.
  const fixFirst =
    fixKind === 'reconnect' ||
    fixKind === 'allow' ||
    fixKind === 'limit' ||
    fixKind === 'doNotCall' ||
    fixKind === 'callDeclined';

  const cancelButton = task.canCancel ? (
    <Button
      variant={cancelVariant}
      icon={X}
      onClick={() => {
        cancel.reset();
        setCancelOpen(true);
      }}
    >
      {t('tasks.actions.cancel')}
    </Button>
  ) : null;

  const nextButton =
    action === 'askAgain' ? (
      // The original request goes into the composer on Home, ready to be changed and sent.
      <Button variant="primary" icon={PenLine} onClick={() => registry?.fillComposer(task.request)}>
        {t('tasks.actions.askAgain')}
      </Button>
    ) : action === 'retry' ? (
      <Button
        // Emphasised only when retrying is likely to help (otherwise the request needs a change).
        // A connection or the purchase limit has to be fixed first: that button leads (Phase C).
        variant={
          (task.status === 'EXPIRED' || task.error?.retryable) && !fixFirst
            ? 'primary'
            : 'secondary'
        }
        icon={RotateCcw}
        onClick={onRetryClick}
        loading={retry.isPending && !ackOpen}
      >
        {t('tasks.actions.retry')}
      </Button>
    ) : null;

  // The dialogs stay mounted when the buttons disappear (e.g. right after a cancel succeeded).
  const dialogs = (
    <>
      <Dialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={t('tasks.cancelDialog.title')}
        description={
          waiting ? t('tasks.cancelDialog.bodyWaiting') : t('tasks.cancelDialog.bodyRunning')
        }
        size="sm"
        busy={cancel.isPending}
        footer={
          <>
            <Button onClick={() => setCancelOpen(false)} disabled={cancel.isPending}>
              {t('tasks.cancelDialog.keep')}
            </Button>
            <Button variant="destructive" onClick={confirmCancel} loading={cancel.isPending}>
              {t('tasks.cancelDialog.confirm')}
            </Button>
          </>
        }
      >
        {cancel.isError && !isApiError(cancel.error, 'INVALID_STATE') && (
          <ErrorBanner error={cancel.error} />
        )}
      </Dialog>

      <Dialog
        open={ackOpen}
        onClose={() => setAckOpen(false)}
        title={t('tasks.retryDialog.title')}
        size="md"
        busy={retry.isPending}
        footer={
          <>
            <Button onClick={() => setAckOpen(false)} disabled={retry.isPending}>
              {t('tasks.retryDialog.keep')}
            </Button>
            <Button
              variant="primary"
              icon={RotateCcw}
              onClick={() => sendRetry(true)}
              disabled={!acknowledged}
              loading={retry.isPending}
            >
              {t('tasks.retryDialog.confirm')}
            </Button>
          </>
        }
      >
        <div className={styles.ackBody}>
          <p>
            {step
              ? t('tasks.retryDialog.body', {
                  step: serverText(i18n, step.titleMessage, step.title),
                })
              : t('tasks.retryDialog.bodyGeneric')}
          </p>
          <p className={styles.ackCheck}>{t('tasks.retryDialog.check')}</p>
          <div className={styles.ack}>
            <input
              id={ackId}
              type="checkbox"
              className={styles.ackInput}
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <label htmlFor={ackId} className={styles.ackLabel}>
              {t('tasks.retryDialog.acknowledge')}
            </label>
          </div>
          {retry.isError && <ErrorBanner error={retry.error} />}
        </div>
      </Dialog>
    </>
  );

  return { cancel: cancelButton, next: nextButton, dialogs };
}
