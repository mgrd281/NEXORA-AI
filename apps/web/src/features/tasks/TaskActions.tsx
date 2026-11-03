'use client';

import type { TaskDetail } from '@jarvis/contracts';
import { RotateCcw, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/i18n/I18nProvider';
import { isApiError, type ApiError } from '@/lib/api/client';
import { useCancelTask, useRetryTask } from './api';
import { attemptOf, failedStep, requiresAcknowledgement } from './model';
import styles from './TaskDetail.module.css';

/**
 * Cancel (with a confirmation) and Retry (with an explicit acknowledgement when the last attempt
 * ended with OUTCOME_UNKNOWN, because the action may already have happened). Shown only when the
 * server says they are possible (canCancel / canRetry). Errors are reported to the screen;
 * focus moves to `focusAfter` once the button that was used disappears.
 */
export function TaskActions({
  task,
  focusAfter,
  onError,
}: {
  task: TaskDetail;
  focusAfter: RefObject<HTMLElement | null>;
  onError: (error: ApiError | null) => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
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

  // The dialogs stay mounted when the buttons disappear (e.g. right after a cancel succeeded).
  return (
    <>
      {task.canCancel && (
        <Button
          variant="secondary"
          icon={X}
          onClick={() => {
            cancel.reset();
            setCancelOpen(true);
          }}
        >
          {t('tasks.actions.cancel')}
        </Button>
      )}
      {task.canRetry && (
        <Button
          // Emphasised only when retrying is likely to help (otherwise the request needs a change).
          variant={task.status === 'EXPIRED' || task.error?.retryable ? 'primary' : 'secondary'}
          icon={RotateCcw}
          onClick={onRetryClick}
          loading={retry.isPending && !ackOpen}
        >
          {t('tasks.actions.retry')}
        </Button>
      )}

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
              ? t('tasks.retryDialog.body', { step: step.title })
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
}
