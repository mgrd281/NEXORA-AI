'use client';

import type { Approval, TaskDetail } from '@jarvis/contracts';
import { Id, isTerminal } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import {
  CalendarClock,
  ChevronLeft,
  CircleCheck,
  FileQuestion,
  Hand,
  Keyboard,
  Mic,
  Terminal,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { ApprovalSheet } from '@/components/approvals/ApprovalSheet';
import { Page } from '@/components/shell/Page';
import { TaskStatusPill } from '@/components/tasks/TaskStatusPill';
import { Banner, ErrorBanner } from '@/components/ui/Banner';
import { RiskBadge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, Section } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Money } from '@/components/ui/Money';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Skeleton, SkeletonRow } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/i18n/I18nProvider';
import { isApiError, type ApiError } from '@/lib/api/client';
import { useAnswerStream } from '@/lib/events/EventStreamProvider';
import { cx } from '@/lib/cx';
import { useTaskDetail } from './api';
import { EvidenceList } from './EvidenceList';
import { ExactTime } from './format';
import { HistorySection } from './HistorySection';
import { attemptOf, guidanceFor, isCancelRequested, pendingApproval, shortHash } from './model';
import { PlanSection } from './PlanSection';
import { TaskActions } from './TaskActions';
import styles from './TaskDetail.module.css';
import { useSpeakVoiceResults } from './useSpeakVoiceResults';

/** "anthropic" → "Anthropic" (provider ids are lower-case slugs). */
function providerName(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

const SOURCE_ICON: Record<TaskDetail['source'], LucideIcon> = {
  text: Keyboard,
  voice: Mic,
  schedule: CalendarClock,
  api: Terminal,
};

/**
 * Task detail — what JARVIS planned, what it did, and the evidence: header with status and
 * actions, the original request, a pending approval, the (streamed) answer, the result with its
 * evidence, the plan, the event history and a details column.
 */
export function TaskDetailScreen({ id }: { id: string }) {
  const valid = Id.safeParse(id).success;
  const detail = useTaskDetail(id, valid);
  useSpeakVoiceResults();

  if (!valid || isApiError(detail.error, 'NOT_FOUND')) return <TaskNotFound />;
  if (detail.isPending) return <TaskDetailSkeleton />;
  if (!detail.data)
    return (
      <TaskLoadError
        error={detail.error}
        onRetry={() => void detail.refetch()}
        retrying={detail.isRefetching}
      />
    );
  // A failed background refresh keeps showing the last known task, with a way to retry.
  return (
    <TaskDetailView
      task={detail.data}
      refreshError={detail.isRefetchError ? detail.error : null}
      onRefresh={() => void detail.refetch()}
    />
  );
}

function BackLink() {
  const { t } = useI18n();
  return (
    <Link href="/tasks" className={styles.back}>
      <Icon icon={ChevronLeft} size={16} mirror />
      {t('tasks.detail.back')}
    </Link>
  );
}

function TaskDetailView({
  task,
  refreshError,
  onRefresh,
}: {
  task: TaskDetail;
  refreshError: unknown;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const statusRef = useRef<HTMLSpanElement>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [reviewing, setReviewing] = useState<Approval | null>(null);
  const approval = pendingApproval(task);
  const decided = useRef(false);
  // After a decision the approval panel (and its button) goes away: focus the task status.
  useEffect(() => {
    if (decided.current && !approval) {
      decided.current = false;
      statusRef.current?.focus();
    }
  }, [approval]);
  const stream = useAnswerStream(isTerminal(task.status) && task.answer ? null : task.id);

  return (
    <div className={styles.frame}>
      <BackLink />
      <Page
        width="wide"
        title={<span dir="auto">{task.title}</span>}
        description={<HeaderMeta task={task} statusRef={statusRef} />}
        actions={<TaskActions task={task} focusAfter={statusRef} onError={setActionError} />}
      >
        <div className={styles.layout}>
          <div className={styles.main}>
            <RequestQuote request={task.request} />
            {refreshError !== null && (
              <ErrorBanner
                title={t('tasks.detail.refreshError')}
                error={refreshError}
                onRetry={onRefresh}
              />
            )}
            {actionError && <ErrorBanner error={actionError} className={styles.actionError} />}
            <StatusBanner task={task} />
            {approval && (
              <ApprovalPanel approval={approval} onReview={() => setReviewing(approval)} />
            )}
            <AnswerSection task={task} streamed={stream.text} />
            <ResultSection task={task} />
            <PlanSection task={task} />
            <HistorySection events={task.events} />
          </div>
          <aside className={styles.side} aria-label={t('tasks.details.title')}>
            <DetailsPanel task={task} />
          </aside>
        </div>
      </Page>
      <ApprovalSheet
        approval={reviewing}
        open={reviewing !== null}
        onClose={() => setReviewing(null)}
        onDecided={() => {
          decided.current = true;
        }}
        hideTaskLink
      />
    </div>
  );
}

function HeaderMeta({
  task,
  statusRef,
}: {
  task: TaskDetail;
  statusRef: RefObject<HTMLSpanElement | null>;
}) {
  const { t } = useI18n();
  const status = t(`common.taskStatus.${task.status}`);
  return (
    <span className={styles.headerMeta}>
      {/* Focus lands here after Cancel / Retry; the status is announced when it changes. */}
      <span ref={statusRef} tabIndex={-1} className={styles.statusFocus}>
        <TaskStatusPill status={task.status} />
        <span className="visually-hidden" role="status" aria-live="polite">
          {status}
        </span>
      </span>
      <span className={styles.metaItem}>
        <RelativeTime
          value={task.createdAt}
          format={(time) => t('tasks.detail.created', { time })}
        />
      </span>
      <span className={styles.metaItem}>
        <Icon icon={SOURCE_ICON[task.source]} size={16} />
        <span className="visually-hidden">
          {t('tasks.detail.sourceLabel', { source: t(`common.source.${task.source}`) })}
        </span>
        <span aria-hidden="true">{t(`common.source.${task.source}`)}</span>
      </span>
    </span>
  );
}

function RequestQuote({ request }: { request: string }) {
  const { t } = useI18n();
  return (
    <figure className={styles.request}>
      <figcaption className={styles.requestLabel}>{t('tasks.detail.request')}</figcaption>
      <blockquote className={styles.requestText} dir="auto">
        {request}
      </blockquote>
    </figure>
  );
}

/** One banner for the state the task is in (cancel requested, failed, cancelled, expired). */
function StatusBanner({ task }: { task: TaskDetail }) {
  const { t } = useI18n();
  if (isCancelRequested(task)) {
    return <Banner tone="info" live title={t('tasks.banners.cancelRequested')} />;
  }
  switch (task.status) {
    case 'FAILED': {
      if (!task.error) return <Banner tone="danger" title={t('tasks.banners.failedTitle')} />;
      const guidance = guidanceFor(task.error);
      return (
        <Banner tone="danger" title={t(`errors.codes.${task.error.code}`)}>
          {task.error.message && <p dir="auto">{task.error.message}</p>}
          <p className={styles.guidance}>
            {t(guidance.key)}
            {guidance.link && (
              <>
                {' '}
                <Link href={guidance.link.href}>{t(guidance.link.key)}</Link>
              </>
            )}
          </p>
        </Banner>
      );
    }
    case 'CANCELLED':
      return <Banner tone="info" title={t('tasks.banners.cancelled')} />;
    case 'EXPIRED':
      return <Banner tone="warning" title={t('tasks.banners.expired')} />;
    default:
      return null;
  }
}

function ApprovalPanel({ approval, onReview }: { approval: Approval; onReview: () => void }) {
  const { t } = useI18n();
  const email = approval.details.kind === 'email' ? approval.details : null;
  return (
    <section className={styles.approval} aria-labelledby={`approval-${approval.id}`}>
      <div className={styles.approvalHead}>
        <span className={styles.approvalIcon} aria-hidden="true">
          <Icon icon={Hand} size={20} />
        </span>
        <div className={styles.approvalText}>
          <h2 id={`approval-${approval.id}`} className={styles.approvalTitle}>
            {t('tasks.approvalPanel.title')}
          </h2>
          <p className={styles.approvalBody}>
            {email ? t('tasks.approvalPanel.bodyEmail') : t('tasks.approvalPanel.bodyGeneric')}
          </p>
        </div>
      </div>
      {/* For email the fields below say exactly what the one-sentence summary says. */}
      {!email && (
        <p className={styles.approvalSummary} dir="auto">
          {approval.summary}
        </p>
      )}
      {email && (
        <dl className={styles.approvalFields}>
          <div>
            <dt>{t('tasks.approvalPanel.to')}</dt>
            <dd>
              {email.to.map((address, i) => (
                <span key={address}>
                  {i > 0 && ', '}
                  <span className="ltr">{address}</span>
                </span>
              ))}
            </dd>
          </div>
          <div>
            <dt>{t('tasks.approvalPanel.subject')}</dt>
            <dd dir="auto">{email.subject}</dd>
          </div>
        </dl>
      )}
      <div className={styles.approvalFoot}>
        <div className={styles.approvalMeta}>
          <RiskBadge level={approval.riskLevel} label={t(`common.risk.${approval.riskLevel}`)} />
          <RelativeTime
            value={approval.expiresAt}
            className={styles.approvalExpires}
            format={(time) => t('approvals.expires', { time })}
          />
        </div>
        <Button variant="primary" onClick={onReview}>
          {t('tasks.approvalPanel.review')}
        </Button>
      </div>
    </section>
  );
}

/** The answer: streamed live from task.answer.delta, then the stored TaskDetail.answer. */
function AnswerSection({ task, streamed }: { task: TaskDetail; streamed: string }) {
  const { t } = useI18n();
  const answerStep = task.steps.find((s) => s.toolId === 'assistant.answer');
  // Streamed text is only shown while the task is still working (a failed task keeps none).
  const text = task.answer ?? (!isTerminal(task.status) && streamed ? streamed : null);
  const writing = !task.answer && streamed !== '' && !isTerminal(task.status);
  const waiting =
    !text &&
    answerStep !== undefined &&
    !isTerminal(task.status) &&
    (answerStep.status === 'RUNNING' || answerStep.status === 'PENDING');
  if (!text && !waiting) return null;
  return (
    <Section
      title={t('tasks.answer.title')}
      description={
        writing ? (
          <span className={styles.writing}>
            <Spinner size={16} />
            {t('tasks.answer.writing')}
          </span>
        ) : undefined
      }
      action={
        task.answer ? <CopyButton value={task.answer} label={t('tasks.answer.copy')} /> : undefined
      }
    >
      <Card>
        {text ? (
          <div className={cx(styles.answer, writing && styles.answerWriting)} dir="auto">
            {text}
          </div>
        ) : (
          <p className={styles.muted}>
            {answerStep?.status === 'RUNNING'
              ? t('tasks.answer.writing')
              : t('tasks.answer.waiting')}
          </p>
        )}
        <span className="visually-hidden" role="status" aria-live="polite">
          {writing ? t('tasks.answer.writing') : task.answer ? t('tasks.answer.ready') : ''}
        </span>
      </Card>
    </Section>
  );
}

function ResultSection({ task }: { task: TaskDetail }) {
  const { t } = useI18n();
  const hasEvidence = task.evidence.length > 0;
  const show =
    task.status === 'COMPLETED' ||
    hasEvidence ||
    (task.resultSummary !== null && task.status !== 'CANCELLED');
  if (!show) return null;
  return (
    <Section title={t('tasks.result.title')}>
      <Card padding="none">
        {task.resultSummary && (
          <div className={styles.resultSummary}>
            {task.status === 'COMPLETED' && (
              <span className={styles.resultIcon} aria-hidden="true">
                <Icon icon={CircleCheck} size={20} />
              </span>
            )}
            <p dir="auto">{task.resultSummary}</p>
          </div>
        )}
        <div
          className={cx(styles.resultEvidence, !task.resultSummary && styles.resultEvidenceOnly)}
        >
          <h3 className={styles.subTitle}>{t('tasks.result.evidence')}</h3>
          {hasEvidence ? (
            <EvidenceList items={task.evidence} />
          ) : (
            <p className={styles.muted}>{t('tasks.result.noEvidence')}</p>
          )}
        </div>
      </Card>
    </Section>
  );
}

function DetailsPanel({ task }: { task: TaskDetail }) {
  const { t } = useI18n();
  const planner = task.planner;
  return (
    <Card>
      <h2 className={styles.sideTitle}>{t('tasks.details.title')}</h2>
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>{t('tasks.details.planner')}</dt>
          <dd>
            {!planner ? (
              <span className={styles.muted}>{t('tasks.details.plannerPending')}</span>
            ) : planner.mode === 'offline' ? (
              t('tasks.details.plannerOffline')
            ) : (
              <span className={styles.plannerModel}>
                {planner.provider && <span>{providerName(planner.provider)}</span>}
                {planner.model && <code className={cx(styles.mono, 'ltr')}>{planner.model}</code>}
                {!planner.provider && !planner.model && t('common.assistant.modelGeneric')}
              </span>
            )}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>{t('tasks.details.estimatedCost')}</dt>
          <dd>
            <Money microUsd={task.cost.estimatedMicroUsd} />
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>{t('tasks.details.actualCost')}</dt>
          <dd>
            <Money microUsd={task.cost.actualMicroUsd} />
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>{t('tasks.details.attempt')}</dt>
          <dd className="tabular">{attemptOf(task)}</dd>
        </div>
        <div className={styles.fact}>
          <dt>{t('tasks.details.source')}</dt>
          <dd className={styles.iconValue}>
            <Icon icon={SOURCE_ICON[task.source]} size={16} />
            {t(`common.source.${task.source}`)}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>{t('tasks.details.created')}</dt>
          <dd>
            <ExactTime value={task.createdAt} />
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>{t('tasks.details.started')}</dt>
          <dd>
            {task.startedAt ? (
              <ExactTime value={task.startedAt} />
            ) : (
              <span className={styles.muted}>{t('tasks.details.notYet')}</span>
            )}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>{t('tasks.details.finished')}</dt>
          <dd>
            {task.completedAt ? (
              <ExactTime value={task.completedAt} />
            ) : (
              <span className={styles.muted}>{t('tasks.details.notYet')}</span>
            )}
          </dd>
        </div>
        <div className={cx(styles.fact, styles.factId)}>
          <dt>{t('tasks.details.taskId')}</dt>
          <dd className={styles.idValue}>
            <code className={cx(styles.mono, 'ltr')} title={task.id}>
              {shortHash(task.id, 8, 4)}
            </code>
            <CopyButton value={task.id} label={t('tasks.details.copyTaskId')} />
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function TaskNotFound() {
  const { t } = useI18n();
  return (
    <div className={styles.frame}>
      <BackLink />
      <Page title={t('tasks.detail.notFoundTitle')} width="wide">
        <Card padding="none">
          <EmptyState
            icon={FileQuestion}
            message={t('tasks.detail.notFound')}
            action={<ButtonLink href="/tasks">{t('tasks.detail.back')}</ButtonLink>}
          />
        </Card>
      </Page>
    </div>
  );
}

function TaskLoadError({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.frame}>
      <BackLink />
      <Page title={t('tasks.detailTitle')} width="wide">
        <ErrorBanner
          title={t('tasks.detail.loadError')}
          error={error}
          onRetry={onRetry}
          retrying={retrying}
        />
      </Page>
    </div>
  );
}

function TaskDetailSkeleton() {
  const { t } = useI18n();
  return (
    <div className={styles.frame}>
      <BackLink />
      <Page
        width="wide"
        title={
          <>
            <span className="visually-hidden">{t('tasks.detailTitle')}</span>
            <Skeleton width="min(28rem, 80%)" height={28} />
          </>
        }
        description={<Skeleton width={220} height={18} />}
      >
        <div className={styles.layout} aria-busy="true">
          <span className="visually-hidden" role="status">
            {t('tasks.detail.loading')}
          </span>
          <div className={styles.main}>
            <Skeleton width="100%" height={56} radius="md" />
            <Card padding="none">
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </Card>
          </div>
          <div className={styles.side}>
            <Card>
              <div className={styles.skeletonFacts}>
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} width="100%" height={16} />
                ))}
              </div>
            </Card>
          </div>
        </div>
      </Page>
    </div>
  );
}

export { TaskDetailSkeleton };
