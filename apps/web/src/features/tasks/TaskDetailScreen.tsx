'use client';

import type { Approval, TaskDetail } from '@jarvis/contracts';
import { Id, isTerminal } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import {
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  CircleCheck,
  FileQuestion,
  Hand,
  Keyboard,
  Mic,
  Terminal,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { ApprovalSentence } from '@/components/approvals/ApprovalSentence';
import { ApprovalSheet } from '@/components/approvals/ApprovalSheet';
import { untrustedSourceFacts } from '@/components/approvals/untrustedSource';
import { Page } from '@/components/shell/Page';
import { TaskStatusPill } from '@/components/tasks/TaskStatusPill';
import { Banner, ErrorBanner } from '@/components/ui/Banner';
import { RiskBadge, StatusPill } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, Section } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Money } from '@/components/ui/Money';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Skeleton, SkeletonRow } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { UserText } from '@/components/ui/UserText';
import { useI18n } from '@/i18n/I18nProvider';
import { isApiError, type ApiError } from '@/lib/api/client';
import { useAnswerStream } from '@/lib/events/EventStreamProvider';
import { cx } from '@/lib/cx';
import { useTaskDetail } from './api';
import { OfflineCommands, TechnicalDetails } from './copy';
import { EvidenceList } from './EvidenceList';
import { ExactTime } from './format';
import { HistorySection } from './HistorySection';
import { useMediaQuery, useOnScreen, WIDE_QUERY } from './hooks';
import {
  attemptOf,
  emailDelivery,
  guidanceFor,
  isCancelRequested,
  isUntrusted,
  needsModel,
  pendingApproval,
  restatesTitle,
  savedMemory,
  shortHash,
  writtenSummary,
} from './model';
import { PlanSection } from './PlanSection';
import { useTaskActions } from './TaskActions';
import styles from './TaskDetail.module.css';

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
 * Task detail — what JARVIS planned, what it did, and the evidence. A pending decision comes
 * first (with a sticky "Review and decide" on phones); then the original request, the task's
 * state, the (streamed) answer, the result with its proof, the plan, the history and details.
 */
export function TaskDetailScreen({ id }: { id: string }) {
  const valid = Id.safeParse(id).success;
  const detail = useTaskDetail(id, valid);

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
  const reviewRef = useRef<HTMLButtonElement>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [reviewing, setReviewing] = useState<Approval | null>(null);
  const approval = pendingApproval(task);
  // While a decision is pending it is the page's one action; Cancel waits at the end.
  const actions = useTaskActions({
    task,
    focusAfter: statusRef,
    onError: setActionError,
    cancelVariant: approval ? 'ghost' : 'secondary',
  });
  const headerCancel = approval ? null : actions.cancel;
  const reviewOnScreen = useOnScreen(reviewRef, approval !== null);
  const barTextId = useId();
  const decided = useRef(false);
  // After a decision the approval panel (and its button) goes away: focus the task status.
  useEffect(() => {
    if (decided.current && !approval) {
      decided.current = false;
      statusRef.current?.focus();
    }
  }, [approval]);
  const stream = useAnswerStream(isTerminal(task.status) && task.answer ? null : task.id);
  const review = (a: Approval) => setReviewing(a);

  return (
    <div className={styles.frame}>
      <BackLink />
      <Page
        width="wide"
        title={<bdi>{task.title}</bdi>}
        description={<HeaderMeta task={task} statusRef={statusRef} />}
        actions={
          headerCancel || actions.next ? (
            <>
              {headerCancel}
              {actions.next}
            </>
          ) : undefined
        }
      >
        <div className={styles.layout}>
          <div className={styles.main}>
            {refreshError !== null && (
              <ErrorBanner
                title={t('tasks.detail.refreshError')}
                error={refreshError}
                onRetry={onRefresh}
              />
            )}
            {actionError && <ErrorBanner error={actionError} />}
            {approval && (
              <ApprovalPanel
                task={task}
                approval={approval}
                reviewRef={reviewRef}
                onReview={() => review(approval)}
              />
            )}
            {!restatesTitle(task.request, task.title) && <RequestQuote request={task.request} />}
            <StatusBanner task={task} />
            <AnswerSection task={task} streamed={stream.text} />
            <ResultSection task={task} />
            <PlanSection task={task} />
            <HistorySection events={task.events} status={task.status} approvals={task.approvals} />
            {approval && actions.cancel && (
              <div className={styles.endActions}>{actions.cancel}</div>
            )}
          </div>
          <aside className={styles.side} aria-label={t('tasks.details.title')}>
            <DetailsPanel task={task} />
          </aside>
        </div>
      </Page>
      {/* Phones: the decision stays within reach once its own button has scrolled away. */}
      {approval && !reviewOnScreen && (
        <div className={styles.decisionBar}>
          <p className={styles.decisionText} id={barTextId}>
            <Icon icon={Hand} size={16} className={styles.decisionIcon} />
            <span>{t('tasks.approvalPanel.title')}</span>
          </p>
          {/* Its own short label: the card's "Review and decide" stays the one by that name. */}
          <Button variant="primary" onClick={() => review(approval)} aria-describedby={barTextId}>
            {t('tasks.approvalPanel.reviewShort')}
          </Button>
        </div>
      )}
      {actions.dialogs}
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
      <blockquote className={styles.requestText}>
        <bdi>{request}</bdi>
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
      // Without an AI model some requests can't be planned: a limit of this setup, not a crash.
      const modelLimit = needsModel(task.error);
      return (
        <Banner tone={modelLimit ? 'info' : 'danger'} title={t(`errors.codes.${task.error.code}`)}>
          <p className={styles.guidance}>
            {t(guidance.key)}
            {!modelLimit && guidance.link && (
              <>
                {' '}
                <Link href={guidance.link.href}>{t(guidance.link.key)}</Link>
              </>
            )}
          </p>
          {modelLimit && (
            <>
              <OfflineCommands />
              <div className={styles.bannerActions}>
                <ButtonLink href="/settings#assistant" size="sm">
                  {t('tasks.actions.setUpModel')}
                </ButtonLink>
              </div>
            </>
          )}
          <TechnicalDetails message={task.error.message} />
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

function ApprovalPanel({
  task,
  approval,
  reviewRef,
  onReview,
}: {
  task: TaskDetail;
  approval: Approval;
  reviewRef: RefObject<HTMLButtonElement | null>;
  onReview: () => void;
}) {
  const { t } = useI18n();
  const email = approval.details.kind === 'email' ? approval.details : null;
  const untrusted = isUntrusted(approval);
  // Which page was flagged and whether the summary still carries its text (same facts and
  // words as the approval sheet).
  const source = untrustedSourceFacts(task);
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
      {!email && <ApprovalSentence approval={approval} className={styles.approvalSummary} />}
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
            <UserText as="dd">{email.subject}</UserText>
          </div>
        </dl>
      )}
      {untrusted && (
        <p className={styles.untrustedNote}>
          {source.host
            ? t('approvals.untrusted.title', { host: source.host })
            : t('approvals.untrusted.titleNoHost')}{' '}
          {source.leftOut === true
            ? t('approvals.untrusted.leftOut')
            : source.leftOut === false
              ? t('approvals.untrusted.mayInclude')
              : t('approvals.untrusted.check')}
        </p>
      )}
      <div className={styles.approvalFoot}>
        <div className={styles.approvalMeta}>
          <RiskBadge level={approval.riskLevel} label={t(`common.risk.${approval.riskLevel}`)} />
          {untrusted && (
            <StatusPill tone="warning" icon={TriangleAlert} label={t('approvals.untrusted.chip')} />
          )}
          <RelativeTime
            value={approval.expiresAt}
            className={styles.approvalExpires}
            format={(time) => t('approvals.expires', { time })}
          />
        </div>
        <Button ref={reviewRef} variant="primary" onClick={onReview}>
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

/**
 * The deliverable first — the summary JARVIS wrote, then where it went — and the proof behind a
 * disclosure (open on desktop, collapsed on phones): what was read, its fingerprint, the mail
 * server's acceptance.
 */
function ResultSection({ task }: { task: TaskDetail }) {
  const { t, f } = useI18n();
  const wide = useMediaQuery(WIDE_QUERY);
  const [proofOpen, setProofOpen] = useState<boolean | null>(null);
  const proofId = useId();
  const hasEvidence = task.evidence.length > 0;
  const show =
    task.status === 'COMPLETED' ||
    hasEvidence ||
    (task.resultSummary !== null && task.status !== 'CANCELLED');
  if (!show) return null;

  // While a step still waits (e.g. for approval) the summary is reviewed in the approval sheet.
  const summary = isTerminal(task.status) ? writtenSummary(task.steps) : null;
  const delivery = emailDelivery(task);
  // Said in the interface language from the step's output (the server writes the request's).
  const remembered = delivery ? null : savedMemory(task.steps);
  const open = proofOpen ?? wide;
  const recipients =
    delivery && delivery.to.length <= 2
      ? f.list(delivery.to)
      : t('approvals.recipients', { count: delivery?.to.length ?? 0 });

  return (
    <Section title={t('tasks.result.title')}>
      <Card padding="none">
        {summary && (
          <div className={styles.deliverable}>
            <div className={styles.deliverableHead}>
              <h3 className={styles.subTitle}>{t('tasks.result.summary')}</h3>
              <CopyButton value={summary} label={t('tasks.result.copySummary')} />
            </div>
            {/* Long-form text in the page's language: it follows its own direction. */}
            <div className={styles.deliverableText} dir="auto">
              {summary}
            </div>
          </div>
        )}
        {delivery ? (
          <p className={cx(styles.outcome, summary && styles.outcomeQuiet)}>
            <Icon icon={CircleCheck} size={16} className={styles.outcomeIcon} />
            <span>
              {t('tasks.result.emailed', { recipients })}
              {delivery.at && (
                <>
                  <span className={styles.outcomeSep} aria-hidden="true">
                    {' · '}
                  </span>
                  <ExactTime value={delivery.at} timeOnly />
                </>
              )}
            </span>
          </p>
        ) : remembered ? (
          <p className={styles.outcome}>
            <Icon icon={CircleCheck} size={20} className={styles.outcomeIcon} />
            <span>{t('tasks.result.remembered', { text: remembered })}</span>
          </p>
        ) : (
          !summary &&
          task.resultSummary && (
            <div className={styles.outcome}>
              {task.status === 'COMPLETED' && (
                <Icon icon={CircleCheck} size={20} className={styles.outcomeIcon} />
              )}
              <UserText as="p">{task.resultSummary}</UserText>
            </div>
          )
        )}
        <div className={styles.proof}>
          {hasEvidence ? (
            <>
              <button
                type="button"
                className={styles.proofToggle}
                aria-expanded={open}
                aria-controls={proofId}
                onClick={() => setProofOpen(!open)}
              >
                <span className={styles.subTitle}>{t('tasks.result.proof')}</span>
                <span className={styles.proofCount}>
                  <span aria-hidden="true">· </span>
                  {t('tasks.result.proofCount', { count: task.evidence.length })}
                </span>
                <Icon icon={ChevronDown} size={16} className={styles.chevron} />
              </button>
              <div id={proofId} hidden={!open}>
                {open && <EvidenceList items={task.evidence} />}
              </div>
            </>
          ) : (
            <p className={styles.muted}>{t('tasks.result.noEvidence')}</p>
          )}
        </div>
      </Card>
    </Section>
  );
}

/** Left-to-right isolate: an amount like "0.00 US$" keeps its order inside an Arabic sentence. */
const ltrIsolate = (text: string) => `\u2066${text}\u2069`;

/** Cost: what was spent (or the estimate while running); offline means no model was paid for. */
function CostValue({ task }: { task: TaskDetail }) {
  const { t, f } = useI18n();
  const { actualMicroUsd: actual, estimatedMicroUsd: estimate } = task.cost;
  if (task.planner?.mode === 'offline' && actual === 0)
    return (
      <span className="tabular">
        {t('tasks.details.costNoModel', { amount: ltrIsolate(f.currency(0)) })}
      </span>
    );
  if (!isTerminal(task.status) && actual === 0 && estimate > 0)
    return (
      <span className="tabular">
        {t('tasks.details.costEstimate', { amount: ltrIsolate(f.currency(estimate)) })}
      </span>
    );
  return <Money microUsd={actual} />;
}

function DetailsPanel({ task }: { task: TaskDetail }) {
  const { t } = useI18n();
  const planner = task.planner;
  const attempt = attemptOf(task);
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
              // The same name the sidebar's assistant status uses.
              t('common.assistant.offlinePlanner')
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
          <dt>{t('tasks.details.cost')}</dt>
          <dd>
            <CostValue task={task} />
          </dd>
        </div>
        {attempt > 1 && (
          <div className={styles.fact}>
            <dt>{t('tasks.details.attempt')}</dt>
            <dd className="tabular">{attempt}</dd>
          </div>
        )}
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
                {Array.from({ length: 5 }, (_, i) => (
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
