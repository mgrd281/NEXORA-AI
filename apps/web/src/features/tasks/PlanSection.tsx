'use client';

import type { ErrorCode, TaskDetail, TaskStep, ToolId } from '@jarvis/contracts';
import { RISK_ORDER } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import {
  BookmarkPlus,
  ChevronDown,
  CircleAlert,
  CornerDownRight,
  FileText,
  Globe,
  Hand,
  Mail,
  MessageSquareText,
  ShieldBan,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { StepStatusPill } from '@/components/tasks/TaskStatusPill';
import { RiskBadge } from '@/components/ui/Badge';
import { Card, Section } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from '@/lib/cx';
import { EvidenceList } from './EvidenceList';
import { useDurationFormat, useExactTimeFormat } from './format';
import {
  completedSteps,
  durationMs,
  guidanceFor,
  previewEntries,
  TOOL_LABEL,
  type PreviewValue,
} from './model';
import styles from './Plan.module.css';

const TOOL_ICON: Record<ToolId, LucideIcon> = {
  'web.fetch': Globe,
  'text.summarize': FileText,
  'email.send': Mail,
  'memory.save': BookmarkPlus,
  'assistant.answer': MessageSquareText,
};

/** What JARVIS planned, step by step, with live status, policy and evidence. */
export function PlanSection({ task }: { task: TaskDetail }) {
  const { t } = useI18n();
  const done = completedSteps(task.steps);
  const total = task.steps.length;

  return (
    <Section
      title={t('tasks.plan.title')}
      description={
        total > 0 ? t('tasks.plan.description', { count: total, completed: done }) : undefined
      }
    >
      {total === 0 ? (
        <Card>
          <PlanEmpty task={task} />
        </Card>
      ) : (
        <Card padding="none">
          <ol className={styles.steps}>
            {task.steps.map((step) => (
              <PlanStep key={step.id} step={step} taskErrorCode={task.error?.code ?? null} />
            ))}
          </ol>
        </Card>
      )}
    </Section>
  );
}

function PlanEmpty({ task }: { task: TaskDetail }) {
  const { t } = useI18n();
  if (task.status === 'PLANNING') {
    return (
      <p className={styles.empty} role="status">
        <Spinner size={16} />
        {t('tasks.plan.planning')}
      </p>
    );
  }
  if (task.status === 'QUEUED') return <p className={styles.empty}>{t('tasks.plan.queued')}</p>;
  return <p className={styles.empty}>{t('tasks.plan.none')}</p>;
}

function PlanStep({ step, taskErrorCode }: { step: TaskStep; taskErrorCode: ErrorCode | null }) {
  const { t, tDynamic } = useI18n();
  const duration = useDurationFormat();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const position = step.position + 1;
  const ms = durationMs(step.startedAt, step.completedAt);
  // Policy is worth showing up front when it asked, blocked, or the risk is above low.
  const notablePolicy =
    step.policy.decision !== 'allow' ||
    RISK_ORDER[step.riskLevel] >= RISK_ORDER.MEDIUM ||
    step.policy.reasons.includes('AUTO_APPROVED_SELF') ||
    step.policy.reasons.includes('UNTRUSTED_CONTENT');
  const reasons = step.policy.reasons.map((code) =>
    tDynamic(`tasks.policy.reasons.${code}`, 'tasks.policy.reasons.unknown', { code }),
  );
  const hasDetails =
    Object.keys(step.inputPreview).length > 0 ||
    (step.output !== null && Object.keys(step.output).length > 0) ||
    step.evidence.length > 0 ||
    !notablePolicy;

  return (
    <li className={styles.step} data-status={step.status}>
      <span className={styles.marker} aria-hidden="true">
        <span className={cx(styles.number, 'tabular')}>{position}</span>
      </span>
      <div className={styles.body}>
        <div className={styles.head}>
          <h3 className={styles.title}>
            <span className="visually-hidden">{t('tasks.plan.stepLabel', { position })}: </span>
            <span dir="auto">{step.title}</span>
          </h3>
          <StepStatusPill status={step.status} className={styles.pill} />
        </div>

        <div className={styles.meta}>
          <span className={styles.tool}>
            <Icon icon={TOOL_ICON[step.toolId]} size={16} className={styles.toolIcon} />
            {t(TOOL_LABEL[step.toolId])}
          </span>
          {RISK_ORDER[step.riskLevel] >= RISK_ORDER.MEDIUM && (
            <RiskBadge level={step.riskLevel} label={t(`common.risk.${step.riskLevel}`)} />
          )}
          {step.requiresApproval && step.status === 'PENDING' && (
            <span className={styles.metaItem}>
              <Icon icon={Hand} size={16} />
              {t('tasks.plan.needsApproval')}
            </span>
          )}
          {ms !== null ? (
            <span className={cx(styles.metaItem, 'tabular')}>
              {t('tasks.plan.duration', { duration: duration(ms) })}
            </span>
          ) : (
            step.status === 'RUNNING' &&
            step.startedAt && (
              <RelativeTime
                value={step.startedAt}
                className={styles.metaItem}
                format={(time) => t('tasks.plan.started', { time })}
              />
            )
          )}
          {hasDetails && (
            <button
              type="button"
              className={styles.toggle}
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((v) => !v)}
            >
              <span className={styles.toggleLabel}>
                {open ? t('tasks.plan.hideDetails') : t('tasks.plan.showDetails')}
                <span className="visually-hidden">
                  {' '}
                  ({t('tasks.plan.stepLabel', { position })})
                </span>
              </span>
              <Icon icon={ChevronDown} size={16} className={styles.chevron} />
            </button>
          )}
        </div>

        {notablePolicy && reasons.length > 0 && (
          <PolicyBlock
            decision={step.policy.decision}
            reasons={reasons}
            emphasized={step.status === 'AWAITING_APPROVAL' || step.policy.decision === 'deny'}
          />
        )}

        {/* The task banner already explains the task's error: here only the step's own cause. */}
        {step.error && <StepError error={step.error} compact={step.error.code === taskErrorCode} />}

        {hasDetails && (
          <div id={panelId} hidden={!open} className={styles.details}>
            {open && <StepDetails step={step} reasons={notablePolicy ? null : reasons} />}
          </div>
        )}
      </div>
    </li>
  );
}

const DECISION_ICON = {
  allow: ShieldCheck,
  require_approval: Hand,
  deny: ShieldBan,
} as const;

function PolicyBlock({
  decision,
  reasons,
  emphasized,
}: {
  decision: TaskStep['policy']['decision'];
  reasons: string[];
  emphasized: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className={cx(styles.policy, emphasized && styles[`policy-${decision}`])}>
      <p className={styles.policyTitle}>
        <Icon icon={DECISION_ICON[decision]} size={16} />
        {t(`tasks.policy.${decision}`)}
      </p>
      <ul className={styles.reasons}>
        {reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

function StepError({
  error,
  compact,
}: {
  error: NonNullable<TaskStep['error']>;
  compact: boolean;
}) {
  const { t } = useI18n();
  const guidance = guidanceFor(error);
  if (compact) {
    return (
      <p className={styles.errorCompact} dir="auto">
        <Icon icon={CircleAlert} size={16} className={styles.errorIcon} />
        <span>{error.message || t(`errors.codes.${error.code}`)}</span>
      </p>
    );
  }
  return (
    <div className={styles.error}>
      <p className={styles.errorTitle}>{t(`errors.codes.${error.code}`)}</p>
      {error.message && (
        <p className={styles.errorMessage} dir="auto">
          {error.message}
        </p>
      )}
      <p className={styles.guidance}>
        {t(guidance.key)}
        {guidance.link && (
          <>
            {' '}
            <Link href={guidance.link.href}>{t(guidance.link.key)}</Link>
          </>
        )}
      </p>
    </div>
  );
}

function StepDetails({ step, reasons }: { step: TaskStep; reasons: string[] | null }) {
  const { t } = useI18n();
  const exact = useExactTimeFormat();
  const input = previewEntries(step.inputPreview);
  const output = previewEntries(step.output);
  return (
    <div className={styles.detailGrid}>
      {input.length > 0 && <PreviewList title={t('tasks.plan.input')} entries={input} />}
      {output.length > 0 && <PreviewList title={t('tasks.plan.output')} entries={output} />}
      {step.evidence.length > 0 && (
        <div className={styles.detailBlock}>
          <h4 className={styles.detailTitle}>{t('tasks.plan.evidence')}</h4>
          <EvidenceList items={step.evidence} compact />
        </div>
      )}
      {reasons && reasons.length > 0 && (
        <div className={styles.detailBlock}>
          <h4 className={styles.detailTitle}>{t('tasks.plan.policy')}</h4>
          <p className={styles.detailText}>
            {t(`tasks.policy.${step.policy.decision}`)} — {reasons.join(' ')}
          </p>
        </div>
      )}
      <p className={cx(styles.detailFoot, 'tabular')}>
        {t('tasks.plan.attempts', { count: step.attempts })}
        {step.startedAt && (
          <>
            <span aria-hidden="true"> · </span>
            {t('tasks.plan.started', { time: exact.full(new Date(step.startedAt)) })}
          </>
        )}
      </p>
    </div>
  );
}

function PreviewList({ title, entries }: { title: string; entries: [string, PreviewValue][] }) {
  const { messages } = useI18n();
  const fieldLabels = messages.tasks.fields as Record<string, string>;
  return (
    <div className={styles.detailBlock}>
      <h4 className={styles.detailTitle}>{title}</h4>
      <dl className={styles.preview}>
        {entries.map(([key, value]) => (
          <div key={key} className={styles.previewRow}>
            <dt>{fieldLabels[key] ?? <span className="ltr">{key}</span>}</dt>
            <dd>
              <PreviewValueView value={value} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PreviewValueView({ value }: { value: PreviewValue }) {
  const { t, f } = useI18n();
  switch (value.type) {
    case 'text':
      return value.url ? (
        <span className={cx(styles.previewMono, 'ltr')}>{value.text}</span>
      ) : (
        <span dir="auto" className={styles.previewText}>
          {value.text}
        </span>
      );
    case 'list':
      return value.items.length === 0 ? (
        <span className={styles.previewNone}>{t('tasks.plan.noneValue')}</span>
      ) : (
        <span dir="auto" className={styles.previewText}>
          {value.items.join(', ')}
        </span>
      );
    case 'boolean':
      return <span>{value.value ? t('tasks.plan.yes') : t('tasks.plan.no')}</span>;
    case 'number':
      return <span className="tabular">{f.number(value.value)}</span>;
    case 'reference':
      return (
        <span className={styles.reference}>
          <Icon icon={CornerDownRight} size={16} mirror />
          {t('tasks.plan.reference')}
          <code className={cx(styles.previewMono, 'ltr')}>{value.ref}</code>
        </span>
      );
    case 'json':
      return <code className={cx(styles.previewMono, 'ltr')}>{value.text}</code>;
  }
}
