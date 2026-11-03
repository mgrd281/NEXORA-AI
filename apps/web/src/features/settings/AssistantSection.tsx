'use client';

import type { AssistantStatus, Me, UsageSummary } from '@jarvis/contracts';
import { CircleCheck, CircleMinus } from 'lucide-react';
import Link from 'next/link';
import { useId, useRef, useState, type FormEvent } from 'react';
import { plannerLabel } from '@/components/shell/AssistantStatusLine';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Skeleton } from '@/components/ui/Skeleton';
import { useI18n } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/catalog';
import { useAssistantStatus } from '@/lib/api/hooks';
import { cx } from '@/lib/cx';
import { useSaveMe, useUsage } from './api';
import { PreferenceSwitch, SaveStatus, SettingRow, SettingsCard } from './controls';
import { SettingsSection } from './SettingsSection';
import { formatBudgetInput, parseBudget, usageLevel } from './budget';
import styles from './settings.module.css';

export function AssistantSection({ me }: { me: Me }) {
  const { t } = useI18n();
  return (
    <SettingsSection id="assistant" title={t('settings.sections.assistant')}>
      <AssistantStatusCard budgetUsd={me.preferences.spending.monthlyAiBudgetUsd} />
      <SettingsCard>
        <PreferenceSwitch
          me={me}
          label={t('settings.assistant.externalModels')}
          description={t('settings.assistant.externalModelsDescription')}
          read={(m) => m.preferences.ai.allowExternalModels}
          write={(v) => ({ preferences: { ai: { allowExternalModels: v } } })}
        />
        <PreferenceSwitch
          me={me}
          label={t('settings.assistant.autoApprove')}
          description={t('settings.assistant.autoApproveDescription', { email: me.email })}
          read={(m) => m.preferences.autonomy.autoApproveEmailToSelf}
          write={(v) => ({ preferences: { autonomy: { autoApproveEmailToSelf: v } } })}
        />
        <BudgetRow me={me} />
        <UsageRow />
      </SettingsCard>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------ status */

const REASON_KEYS: Record<string, MessageKey> = {
  NO_API_KEY: 'settings.assistant.reasons.NO_API_KEY',
  USER_DISABLED_EXTERNAL_MODELS: 'settings.assistant.reasons.USER_DISABLED_EXTERNAL_MODELS',
  BUDGET_EXHAUSTED: 'settings.assistant.reasons.BUDGET_EXHAUSTED',
};

type Capability = keyof AssistantStatus['capabilities'];
const CAPABILITY_FIX: Record<Capability, string | null> = {
  webFetch: '/connections',
  email: '/connections',
  memory: '/memory',
  generalQuestions: null,
};

function plannerReason(status: AssistantStatus, budgetUsd: number): MessageKey {
  const reason = status.planner.reason;
  if (reason === 'BUDGET_EXHAUSTED' && budgetUsd <= 0)
    return 'settings.assistant.reasons.BUDGET_ZERO';
  return (reason && REASON_KEYS[reason]) || 'settings.assistant.reasons.unknown';
}

function AssistantStatusCard({ budgetUsd }: { budgetUsd: number }) {
  const { t } = useI18n();
  const status = useAssistantStatus();
  const titleId = useId();

  if (status.isError && !status.data) {
    return (
      <ErrorBanner
        error={status.error}
        title={t('settings.assistant.statusFailed')}
        onRetry={() => void status.refetch()}
        retrying={status.isFetching}
      />
    );
  }

  const s = status.data;
  return (
    <SettingsCard>
      <div className={styles.cardHeader}>
        <h3 id={titleId} className={styles.rowTitle}>
          {t('settings.assistant.statusTitle')}
        </h3>
      </div>
      {!s ? (
        <div className={styles.skeletonBody} aria-busy="true">
          <span className="visually-hidden" role="status">
            {t('common.status.loading')}
          </span>
          <Skeleton width="40%" height={16} />
          <Skeleton width="85%" height={14} />
          <Skeleton width="30%" height={16} />
        </div>
      ) : (
        <dl className={styles.statusList} aria-labelledby={titleId}>
          <div className={styles.statusItem}>
            <dt>{t('settings.assistant.planner')}</dt>
            <dd>
              <span className={styles.statusValue}>
                <span
                  className={cx(styles.dot, s.planner.mode === 'model' && styles.dotOk)}
                  aria-hidden="true"
                />
                {plannerLabel(s, t)}
              </span>
              <span className={styles.rowText}>
                {s.planner.mode === 'model'
                  ? t('settings.assistant.plannerModelNote')
                  : t(plannerReason(s, budgetUsd))}
              </span>
            </dd>
          </div>
          <div className={styles.statusItem}>
            <dt>{t('settings.assistant.worker')}</dt>
            <dd>
              <span className={styles.statusValue}>
                <span
                  className={cx(styles.dot, s.worker.healthy ? styles.dotOk : styles.dotBad)}
                  aria-hidden="true"
                />
                {s.worker.healthy
                  ? t('settings.assistant.workerHealthy')
                  : t('settings.assistant.workerUnhealthy')}
              </span>
              <span className={styles.note}>
                {s.worker.lastHeartbeatAt ? (
                  <RelativeTime
                    value={s.worker.lastHeartbeatAt}
                    format={(time) => t('settings.assistant.heartbeat', { time })}
                  />
                ) : (
                  t('settings.assistant.noHeartbeat')
                )}
              </span>
              {!s.worker.healthy && (
                <span className={styles.rowText}>
                  {t('settings.assistant.workerUnhealthyNote')}
                </span>
              )}
            </dd>
          </div>
          <div className={styles.statusItem}>
            <dt>{t('settings.assistant.capabilities')}</dt>
            <dd>
              <ul className={styles.capabilities}>
                {(Object.keys(CAPABILITY_FIX) as Capability[]).map((key) => {
                  const on = s.capabilities[key];
                  const href = CAPABILITY_FIX[key];
                  return (
                    <li key={key} className={cx(styles.capability, !on && styles.capabilityOff)}>
                      <span className={styles.capabilityIcon}>
                        <Icon icon={on ? CircleCheck : CircleMinus} size={16} />
                      </span>
                      <span className={styles.capabilityText}>
                        <span>
                          {t(`settings.assistant.capability.${key}`)}
                          <span className="visually-hidden">
                            {': '}
                            {on
                              ? t('settings.assistant.capabilityOn')
                              : t('settings.assistant.capabilityOff')}
                          </span>
                        </span>
                        {!on &&
                          (href ? (
                            <Link href={href} className={styles.capabilityFix}>
                              {t(`settings.assistant.capabilityFix.${key}`)}
                            </Link>
                          ) : (
                            <span className={styles.capabilityFix}>
                              {t(`settings.assistant.capabilityFix.${key}`)}
                            </span>
                          ))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </dd>
          </div>
          <div className={styles.statusItem}>
            <dt>{t('settings.assistant.version')}</dt>
            <dd>
              <span className={cx('t-mono ltr', styles.ltrValue)}>{s.version}</span>
            </dd>
          </div>
        </dl>
      )}
    </SettingsCard>
  );
}

/* ------------------------------------------------------------------ budget */

function BudgetRow({ me }: { me: Me }) {
  const { t, locale } = useI18n();
  const saver = useSaveMe();
  const saved = me.preferences.spending.monthlyAiBudgetUsd;
  const [draft, setDraft] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const value = draft ?? formatBudgetInput(saved, locale);
  const parsed = parseBudget(value, locale);
  // Enabled as soon as the text changes; an invalid amount is explained on submit.
  const changed = draft !== null && (parsed === null || parsed !== saved);
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (parsed === null) {
      inputRef.current?.focus();
      return;
    }
    if (parsed === saved || saver.pending) return;
    saver.save(
      { preferences: { spending: { monthlyAiBudgetUsd: parsed } } },
      { onSuccess: () => setDraft(null) },
    );
  }

  return (
    <SettingRow>
      <form className={styles.inlineForm} onSubmit={submit} noValidate>
        <TextField
          ref={inputRef}
          label={t('settings.assistant.budget')}
          aria-describedby={hintId}
          error={touched && parsed === null ? t('settings.assistant.budgetInvalid') : undefined}
          value={value}
          inputMode="decimal"
          autoComplete="off"
          dir="ltr"
          fieldClassName={styles.budgetField}
          trailing={
            <span className={styles.unit} aria-hidden="true">
              {t('settings.assistant.budgetUnit')}
            </span>
          }
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setTouched(true)}
        />
        <Button
          type="submit"
          className={styles.inlineAction}
          disabled={!changed}
          loading={saver.pending}
        >
          {t('settings.assistant.budgetSave')}
        </Button>
      </form>
      <p id={hintId} className={styles.note}>
        {t('settings.assistant.budgetHint')}
      </p>
      <SaveStatus state={saver.state} error={saver.error} />
    </SettingRow>
  );
}

/* ------------------------------------------------------------------ usage */

function UsageRow() {
  const { t, f } = useI18n();
  const usage = useUsage();
  const titleId = useId();

  return (
    <SettingRow>
      <div className={styles.usageHead}>
        <h3 id={titleId} className={styles.rowTitle}>
          {t('settings.assistant.usageTitle')}
        </h3>
        {usage.data && (
          <span className={styles.note}>
            {t('settings.assistant.usageResets', { date: f.date(usage.data.periodEnd) })}
          </span>
        )}
      </div>
      {usage.isError && !usage.data ? (
        <ErrorBanner
          error={usage.error}
          title={t('settings.assistant.usageFailed')}
          onRetry={() => void usage.refetch()}
          retrying={usage.isFetching}
        />
      ) : !usage.data ? (
        <div className={styles.skeletonBody} aria-busy="true">
          <span className="visually-hidden" role="status">
            {t('common.status.loading')}
          </span>
          <Skeleton width="35%" height={24} />
          <Skeleton width="100%" height={8} radius="full" />
          <Skeleton width="50%" height={12} />
        </div>
      ) : (
        <UsageDetails usage={usage.data} labelledBy={titleId} />
      )}
    </SettingRow>
  );
}

/** Keeps an amount ("4.82 US$") in one left-to-right run inside a translated sentence. */
const ltr = (text: string) => `\u2066${text}\u2069`;

function UsageDetails({ usage, labelledBy }: { usage: UsageSummary; labelledBy: string }) {
  const { t, f } = useI18n();
  const spent = ltr(f.currency(usage.aiMicroUsd));
  const budget = ltr(f.currency(usage.budgetMicroUsd));
  const level = usageLevel(usage.aiMicroUsd, usage.budgetMicroUsd);
  const fraction =
    usage.budgetMicroUsd > 0 ? Math.min(1, usage.aiMicroUsd / usage.budgetMicroUsd) : 0;

  return (
    <>
      {usage.budgetMicroUsd > 0 ? (
        <>
          <p className={styles.usageAmount}>
            <bdi className="tabular">{t('settings.assistant.usageSpent', { spent, budget })}</bdi>
          </p>
          <div
            role="meter"
            aria-labelledby={labelledBy}
            aria-valuemin={0}
            aria-valuemax={usage.budgetMicroUsd}
            aria-valuenow={Math.min(usage.aiMicroUsd, usage.budgetMicroUsd)}
            aria-valuetext={t('settings.assistant.usageMeterText', { spent, budget })}
            className={cx(
              styles.meter,
              level === 'warn' && styles.meterWarn,
              level === 'full' && styles.meterFull,
            )}
          >
            <span className={styles.meterFill} style={{ inlineSize: `${fraction * 100}%` }} />
          </div>
        </>
      ) : (
        <p className={styles.rowText}>{t('settings.assistant.usageNoPaid')}</p>
      )}
      {level === 'full' && (
        <p className={styles.warningText}>{t('settings.assistant.usageExhausted')}</p>
      )}
      <p className={styles.note}>
        <bdi className="tabular">
          {t('settings.assistant.usageBreakdown', {
            ai: ltr(f.currency(usage.aiMicroUsd)),
            tools: ltr(f.currency(usage.toolMicroUsd)),
          })}
        </bdi>
      </p>
      <dl className={styles.taskStats}>
        <div className={styles.taskStat}>
          <dt>{t('settings.assistant.tasksCompleted')}</dt>
          <dd className="tabular">{f.number(usage.tasks.completed)}</dd>
        </div>
        <div className={styles.taskStat}>
          <dt>{t('settings.assistant.tasksFailed')}</dt>
          <dd className="tabular">{f.number(usage.tasks.failed)}</dd>
        </div>
        <div className={styles.taskStat}>
          <dt>{t('settings.assistant.tasksTotal')}</dt>
          <dd className="tabular">{f.number(usage.tasks.total)}</dd>
        </div>
      </dl>
    </>
  );
}
