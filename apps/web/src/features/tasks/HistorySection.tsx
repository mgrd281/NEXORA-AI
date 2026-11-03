'use client';

import type { Approval, ServerMessage, TaskEvent, TaskStatus, TaskStep } from '@jarvis/contracts';
import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { ApprovalSentence } from '@/components/approvals/ApprovalSentence';
import { Card, Section } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { useI18n } from '@/i18n/I18nProvider';
import { errorLine, renderServerMessage, serverText } from '@/i18n/server-message';
import { cx } from '@/lib/cx';
import { useExactTimeFormat } from './format';
import styles from './History.module.css';
import {
  describeEvent,
  historyMilestones,
  timelineRows,
  type CheckLine,
  type TimelineRow,
} from './model';

/**
 * The task's event timeline with localized descriptions and exact timestamps (account time
 * zone). Collapsed at every width behind a one-line summary ("Asked · Approved · Sent · 9:05 PM"):
 * the plan and the result above already say what happened; this is the audit trail.
 */
export function HistorySection({
  events,
  status,
  approvals,
  steps = [],
}: {
  events: readonly TaskEvent[];
  status: TaskStatus;
  /** The task's approvals: the "asked for your approval" row names the action from these. */
  approvals: readonly Approval[];
  /** The task's steps: rows and checks name a step by its title in the viewer's locale. */
  steps?: readonly Pick<TaskStep, 'id' | 'title' | 'titleMessage'>[];
}) {
  const { t, f } = useI18n();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rows = timelineRows(events);
  const last = rows.at(-1)?.event;
  const summary =
    rows.length > 0
      ? [...historyMilestones(events, status).map((key) => t(key)), last ? f.time(last.at) : null]
          .filter(Boolean)
          .join(' · ')
      : undefined;

  return (
    <Section
      title={t('tasks.history.title')}
      description={summary}
      action={
        rows.length > 0 ? (
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen(!open)}
          >
            {open ? t('tasks.history.hide') : t('tasks.history.show')}
            <Icon icon={ChevronDown} size={16} className={styles.chevron} />
          </button>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <Card>
          <p className={styles.empty}>{t('tasks.history.empty')}</p>
        </Card>
      ) : (
        <div id={panelId} hidden={!open}>
          {open && (
            <Card padding="none">
              <Timeline rows={rows} approvals={approvals} steps={steps} />
            </Card>
          )}
        </div>
      )}
    </Section>
  );
}

function Timeline({
  rows,
  approvals,
  steps,
}: {
  rows: readonly TimelineRow[];
  approvals: readonly Approval[];
  steps: readonly Pick<TaskStep, 'id' | 'title' | 'titleMessage'>[];
}) {
  const i18n = useI18n();
  const { t, f } = i18n;
  const exact = useExactTimeFormat();
  const statusLabel = (s: TaskStatus) => t(`common.taskStatus.${s}`);
  const message = (m: unknown) => renderServerMessage(i18n, m as ServerMessage | null);
  const stepTitle = (id: unknown): string | null => {
    const step = typeof id === 'string' ? steps.find((s) => s.id === id) : undefined;
    return step ? serverText(i18n, step.titleMessage, step.title) : null;
  };
  const days = rows.map((r) => exact.dayKey(new Date(r.event.at)));
  return (
    <ol className={styles.timeline}>
      {rows.map(({ event, durationMs }, i) => {
        const d = describeEvent(event, statusLabel, t('tasks.events.unknownStep'), message);
        const failedSteps = d.failedStepIds?.map(stepTitle).filter((x): x is string => x !== null);
        const at = new Date(event.at);
        // The approval's own sentence, in the interface language (the server's is in the
        // request's language).
        const approval =
          event.type === 'approval.requested'
            ? approvals.find((a) => a.id === event.data.approvalId)
            : undefined;
        // The full date on the first event of each day; times only after that.
        const showDate = i === 0 || days[i] !== days[i - 1];
        return (
          <li key={event.id} className={styles.event} data-tone={d.tone}>
            <span className={styles.dot} aria-hidden="true" />
            <div className={styles.body}>
              <p className={styles.text}>
                {t(d.key, d.params)}
                {durationMs !== null && (
                  <span className={cx(styles.took, 'tabular')}>
                    {' · '}
                    {t('tasks.plan.duration', { duration: f.duration(durationMs) })}
                  </span>
                )}
              </p>
              {d.error && (
                <p className={styles.details}>
                  {errorLine(i18n, d.error, { step: stepTitle(event.data.stepId) })}
                </p>
              )}
              {failedSteps && failedSteps.length > 0 && (
                <p className={styles.details}>
                  {t('errors.reasons.VERIFICATION_FAILED', { steps: f.list(failedSteps) })}
                </p>
              )}
              {approval && <ApprovalSentence approval={approval} className={styles.details} />}
              {/* Server-written lines: isolated, but aligned with the timeline's direction. */}
              {!approval && d.details && d.details.length > 0 && (
                <ul className={styles.details}>
                  {d.details.map((line, j) => (
                    <li key={j}>
                      <bdi>{line}</bdi>
                    </li>
                  ))}
                </ul>
              )}
              {d.checks && d.checks.length > 0 && (
                <Checks
                  checks={d.checks}
                  passed={event.type === 'verification.passed'}
                  stepTitle={stepTitle}
                />
              )}
            </div>
            <time
              dateTime={at.toISOString()}
              title={exact.full(at)}
              className={cx(styles.time, 'tabular')}
            >
              {showDate ? exact.full(at) : exact.time(at)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}

/** "9 checks passed", with the individual results one click away. */
function Checks({
  checks,
  passed,
  stepTitle,
}: {
  checks: readonly CheckLine[];
  passed: boolean;
  stepTitle: (id: unknown) => string | null;
}) {
  const { t, tDynamic } = useI18n();
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className={styles.checks}>
      <button
        type="button"
        className={styles.checksToggle}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
      >
        {passed
          ? t('tasks.history.checksPassed', { count: checks.length })
          : t('tasks.history.checksRun', { count: checks.length })}
        <Icon icon={ChevronDown} size={16} className={styles.chevron} />
      </button>
      <ul id={listId} hidden={!open} className={styles.details}>
        {checks.map((c, i) => (
          <li key={i}>
            {/* "<step>: <check>" — the step's title isolated, the check in the interface's
                direction (or, when it is not one JARVIS knows, the stored line isolated). */}
            {(stepTitle(c.stepId) ?? c.step) && (
              <>
                <bdi>{stepTitle(c.stepId) ?? c.step}</bdi>
                {': '}
              </>
            )}
            {c.key ? (
              tDynamic(c.key, 'tasks.checks.unknown', { ...c.params, text: c.text })
            ) : (
              <bdi>{c.text}</bdi>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
