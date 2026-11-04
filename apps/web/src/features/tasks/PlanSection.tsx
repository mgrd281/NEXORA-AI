'use client';

import type { TaskDetail, TaskStep, ToolId } from '@jarvis/contracts';
import { RISK_ORDER } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import {
  AppWindow,
  BellRing,
  BookmarkPlus,
  CalendarCheck,
  CalendarClock,
  CalendarCog,
  CalendarDays,
  CalendarPlus,
  CalendarSearch,
  CalendarX,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CornerDownRight,
  CreditCard,
  FilePen,
  FileSearch,
  FileText,
  Globe,
  Hand,
  History,
  Languages,
  Mail,
  MailOpen,
  MailSearch,
  MessageCircleQuestionMark,
  MessageSquareText,
  Scale,
  ScanSearch,
  ShieldBan,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  TextCursorInput,
  TimerOff,
} from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { StepStatusPill } from '@/components/tasks/TaskStatusPill';
import { RiskBadge, StatusPill } from '@/components/ui/Badge';
import { Card, Section } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/i18n/I18nProvider';
import { errorReason, errorTitle, serverText } from '@/i18n/server-message';
import { cx } from '@/lib/cx';
import { OfflineCommands, TechnicalDetails } from './copy';
import { EvidenceList } from './EvidenceList';
import { useExactTimeFormat } from './format';
import {
  completedSteps,
  durationMs,
  guidanceFor,
  isStepAhead,
  needsModel,
  pendingApproval,
  previewEntries,
  stepDecision,
  stepDisplayStatus,
  TOOL_LABEL,
  type PreviewValue,
} from './model';
import styles from './Plan.module.css';

export const TOOL_ICON: Record<ToolId, LucideIcon> = {
  'web.fetch': Globe,
  'text.summarize': FileText,
  'email.send': Mail,
  'memory.save': BookmarkPlus,
  'assistant.answer': MessageSquareText,
  'document.analyze': FileSearch,
  'text.translate': Languages,
  'schedule.create': CalendarClock,
  'conversation.recall': History,
  'assistant.clarify': MessageCircleQuestionMark,
  // Phase C
  'email.search': MailSearch,
  'email.read_thread': MailOpen,
  'email.draft_reply': FilePen,
  'email.track_replies': BellRing,
  'calendar.list': CalendarDays,
  'calendar.free_busy': CalendarSearch,
  'calendar.create_event': CalendarPlus,
  'calendar.update_event': CalendarCog,
  'calendar.cancel_event': CalendarX,
  'booking.find_slots': ScanSearch,
  'booking.book': CalendarCheck,
  'browser.read': AppWindow,
  'browser.fill': TextCursorInput,
  'shop.search': ShoppingBag,
  'shop.compare': Scale,
  'shop.prepare_cart': ShoppingCart,
  'shop.checkout': CreditCard,
};

/** Recipient reasons of an invitation or a draft are not about an email being sent. */
const REASON_BY_TOOL: Partial<Record<ToolId, 'invitation' | 'draft'>> = {
  'calendar.create_event': 'invitation',
  'calendar.update_event': 'invitation',
  'calendar.cancel_event': 'invitation',
  'email.draft_reply': 'draft',
};

function policyReasonKey(toolId: ToolId, code: string): string {
  const group = REASON_BY_TOOL[toolId];
  return group && ['RECIPIENT_EXTERNAL', 'MANY_RECIPIENTS', 'RECIPIENT_SELF'].includes(code)
    ? `tasks.policy.reasonsByTool.${group}.${code}`
    : `tasks.policy.reasons.${code}`;
}

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
              <PlanStep key={step.id} step={step} task={task} />
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

const DECIDED_ICON = { APPROVED: CircleCheck, REJECTED: CircleSlash, EXPIRED: TimerOff } as const;

function PlanStep({ step, task }: { step: TaskStep; task: TaskDetail }) {
  const i18n = useI18n();
  const { t, tDynamic, f } = i18n;
  const title = serverText(i18n, step.titleMessage, step.title);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const position = step.position + 1;
  const ms = durationMs(step.startedAt, step.completedAt);
  const shown = stepDisplayStatus(step, task.status);
  // Policy is current only while the step is still ahead: then it explains what will happen.
  const ahead = isStepAhead(step, task.status);
  const notablePolicy =
    step.policy.decision !== 'allow' ||
    RISK_ORDER[step.riskLevel] >= RISK_ORDER.MEDIUM ||
    step.policy.reasons.includes('AUTO_APPROVED_SELF') ||
    step.policy.reasons.includes('UNTRUSTED_CONTENT');
  const reason = (code: string) =>
    tDynamic(policyReasonKey(step.toolId, code), 'tasks.policy.reasons.unknown', { code });
  const reasons = step.policy.reasons.map(reason);
  // The approval card at the top already flags untrusted content for the pending decision.
  const flaggedAbove = pendingApproval(task)?.stepId === step.id;
  const boxReasons = step.policy.reasons
    .filter((code) => !(flaggedAbove && code === 'UNTRUSTED_CONTENT'))
    .map(reason);
  const showBox =
    notablePolicy &&
    boxReasons.length > 0 &&
    (ahead || (step.policy.decision === 'deny' && step.status === 'BLOCKED'));
  const decision = stepDecision(task.approvals, step.id);
  const autoApproved =
    step.status === 'SUCCEEDED' && step.policy.reasons.includes('AUTO_APPROVED_SELF');
  const hasDetails =
    Object.keys(step.inputPreview).length > 0 ||
    (step.output !== null && Object.keys(step.output).length > 0) ||
    step.evidence.length > 0 ||
    (!showBox && reasons.length > 0);

  return (
    <li className={styles.step} data-status={shown}>
      <span className={styles.marker} aria-hidden="true">
        <span className={cx(styles.number, 'tabular')}>{position}</span>
      </span>
      <div className={styles.body}>
        <div className={styles.head}>
          <h3 className={styles.title}>
            <span className="visually-hidden">{t('tasks.plan.stepLabel', { position })}: </span>
            <bdi>{title}</bdi>
          </h3>
          {shown === 'NOT_RUN' ? (
            <StatusPill
              tone="neutral"
              icon={CircleSlash}
              label={t('tasks.plan.notRun')}
              className={styles.pill}
            />
          ) : (
            <StepStatusPill status={shown} className={styles.pill} />
          )}
        </div>

        <div className={styles.meta}>
          <span className={styles.tool}>
            <Icon icon={TOOL_ICON[step.toolId]} size={16} className={styles.toolIcon} />
            {t(TOOL_LABEL[step.toolId])}
          </span>
          {RISK_ORDER[step.riskLevel] >= RISK_ORDER.MEDIUM && shown !== 'NOT_RUN' && (
            <RiskBadge level={step.riskLevel} label={t(`common.risk.${step.riskLevel}`)} />
          )}
          {step.requiresApproval && step.status === 'PENDING' && ahead && (
            <span className={styles.metaItem}>
              <Icon icon={Hand} size={16} />
              {t('tasks.plan.needsApproval')}
            </span>
          )}
          {ms !== null ? (
            <span className={cx(styles.metaItem, 'tabular')}>
              {t('tasks.plan.duration', { duration: f.duration(ms) })}
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

        {showBox && (
          <PolicyBlock
            decision={step.policy.decision}
            reasons={boxReasons}
            emphasized={step.policy.decision === 'deny'}
          />
        )}

        {/* After the decision: one past-tense line instead of the reasons it was asked for. */}
        {decision && (
          <p className={styles.decided} data-decision={decision.status}>
            <Icon icon={DECIDED_ICON[decision.status]} size={16} className={styles.decidedIcon} />
            {t(`tasks.plan.decided.${decision.status}`, { time: f.time(decision.decidedAt) })}
          </p>
        )}
        {!decision && autoApproved && (
          <p className={styles.decided}>
            <Icon icon={ShieldCheck} size={16} className={styles.decidedIcon} />
            {t('tasks.plan.autoApproved')}
          </p>
        )}

        {/* The task banner already explains the task's error: here only the step's own cause. */}
        {step.error && (
          <StepError
            error={step.error}
            stepTitle={title}
            compact={step.error.code === task.error?.code}
          />
        )}

        {hasDetails && (
          <div id={panelId} hidden={!open} className={styles.details}>
            {open && <StepDetails step={step} reasons={showBox ? null : reasons} />}
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
  stepTitle,
  compact,
}: {
  error: NonNullable<TaskStep['error']>;
  stepTitle: string;
  compact: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const guidance = guidanceFor(error);
  const reason = errorReason(i18n, error, { step: stepTitle });
  // The localized title says what happened; the server's wording stays behind a disclosure.
  // Compact: the task banner above already explains it, so only the step's own cause.
  if (compact) {
    return (
      <p className={styles.errorCompact}>
        <Icon icon={CircleAlert} size={16} className={styles.errorIcon} />
        <span>{reason ?? errorTitle(i18n, error)}</span>
      </p>
    );
  }
  return (
    <div className={styles.error}>
      <p className={styles.errorTitle}>{errorTitle(i18n, error)}</p>
      {reason && <p className={styles.guidance}>{reason}</p>}
      <p className={styles.guidance}>
        {t(guidance.key)}
        {guidance.link && !needsModel(error) && (
          <>
            {' '}
            <Link href={guidance.link.href}>{t(guidance.link.key)}</Link>
          </>
        )}
      </p>
      {needsModel(error) && (
        <>
          <OfflineCommands />
          <Link href="/settings#assistant" className={styles.errorLink}>
            {t('tasks.actions.setUpModel')}
          </Link>
        </>
      )}
      <TechnicalDetails message={error.message} />
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
