'use client';

import type { Me, UsageSummary } from '@jarvis/contracts';
import { useId, useRef, useState, type FormEvent } from 'react';
import { ErrorBanner } from '@/components/ui/Banner';
import { TextField } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { useI18n } from '@/i18n/I18nProvider';
import { useAssistantStatus } from '@/lib/api/hooks';
import { cx } from '@/lib/cx';
import { useSaveMe, useUsage } from './api';
import { formatBudgetInput, parseBudget, usageLevel } from './budget';
import { SaveStatus, SettingRow, SettingsCard } from './controls';
import { SettingsSection } from './SettingsSection';
import styles from './settings.module.css';

/**
 * The monthly AI budget and this month's usage. While the server has no AI model key, the
 * budget can still be set but applies to nothing yet, and the block says so.
 */
export function UsageSection({ me }: { me: Me }) {
  const { t } = useI18n();
  const status = useAssistantStatus();
  const inactive = status.data?.planner.reason === 'NO_API_KEY';
  // The budget hint also describes the meter while the budget applies to nothing yet.
  const hintId = useId();
  return (
    <SettingsSection id="usage" title={t('settings.sections.usage')}>
      <SettingsCard>
        <BudgetRow me={me} inactive={inactive} hintId={hintId} />
        <UsageRow inactive={inactive} inactiveHintId={hintId} />
      </SettingsCard>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------ budget */

/** Saves when the field is left or Enter is pressed, like every other setting on the page. */
function BudgetRow({ me, inactive, hintId }: { me: Me; inactive: boolean; hintId: string }) {
  const { t, locale } = useI18n();
  const saver = useSaveMe();
  const saved = me.preferences.spending.monthlyAiBudgetUsd;
  const [draft, setDraft] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const value = draft ?? formatBudgetInput(saved, locale);
  const parsed = parseBudget(value, locale);
  const inputRef = useRef<HTMLInputElement>(null);

  function commit() {
    if (draft === null) return;
    setTouched(true);
    if (parsed === null) return;
    if (parsed === saved) {
      setDraft(null);
      return;
    }
    if (saver.pending) return;
    saver.save(
      { preferences: { spending: { monthlyAiBudgetUsd: parsed } } },
      // Keep anything typed while the save was running.
      { onSuccess: () => setDraft((d) => (d === value ? null : d)) },
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (parsed === null) {
      setTouched(true);
      inputRef.current?.focus();
      return;
    }
    commit();
  }

  return (
    <SettingRow>
      <form onSubmit={submit} noValidate>
        <TextField
          ref={inputRef}
          label={t('settings.assistant.budget')}
          aria-describedby={hintId}
          error={touched && parsed === null ? t('settings.assistant.budgetInvalid') : undefined}
          value={value}
          inputMode="decimal"
          enterKeyHint="done"
          autoComplete="off"
          dir="ltr"
          fieldClassName={styles.budgetField}
          trailing={
            <span className={styles.unit} aria-hidden="true">
              {t('settings.assistant.budgetUnit')}
            </span>
          }
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && draft !== null) {
              e.preventDefault();
              setDraft(null);
              setTouched(false);
            }
          }}
        />
      </form>
      <p id={hintId} className={styles.note}>
        {inactive ? t('settings.assistant.budgetHintInactive') : t('settings.assistant.budgetHint')}
      </p>
      <SaveStatus state={saver.state} error={saver.error} />
    </SettingRow>
  );
}

/* ------------------------------------------------------------------ usage */

function UsageRow({ inactive, inactiveHintId }: { inactive: boolean; inactiveHintId: string }) {
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
        <UsageDetails
          usage={usage.data}
          labelledBy={titleId}
          describedBy={inactive ? inactiveHintId : undefined}
        />
      )}
    </SettingRow>
  );
}

/** Keeps an amount ("4.82 US$") in one left-to-right run inside a translated sentence. */
const ltr = (text: string) => `⁦${text}⁩`;

/** `describedBy` is set while no AI model is set up: the meter is then shown as inactive. */
function UsageDetails({
  usage,
  labelledBy,
  describedBy,
}: {
  usage: UsageSummary;
  labelledBy: string;
  describedBy?: string;
}) {
  const { t, f } = useI18n();
  const spent = ltr(f.currency(usage.aiMicroUsd));
  const budget = ltr(f.currency(usage.budgetMicroUsd));
  const level = usageLevel(usage.aiMicroUsd, usage.budgetMicroUsd);
  const fraction =
    usage.budgetMicroUsd > 0 ? Math.min(1, usage.aiMicroUsd / usage.budgetMicroUsd) : 0;
  const inactive = describedBy !== undefined;

  return (
    <>
      {usage.budgetMicroUsd > 0 ? (
        <div className={cx(styles.usageMeterBlock, inactive && styles.usageInactive)}>
          <p className={styles.usageAmount}>
            <bdi className="tabular">{t('settings.assistant.usageSpent', { spent, budget })}</bdi>
          </p>
          <div
            role="meter"
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
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
        </div>
      ) : (
        <p className={styles.rowText}>{t('settings.assistant.usageNoPaid')}</p>
      )}
      {level === 'full' && !inactive && (
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
          <dt>{t('settings.assistant.tasksTotal')}</dt>
          <dd className="tabular">{f.number(usage.tasks.total)}</dd>
        </div>
        <div className={styles.taskStat}>
          <dt>{t('settings.assistant.tasksCompleted')}</dt>
          <dd className="tabular">{f.number(usage.tasks.completed)}</dd>
        </div>
        <div className={styles.taskStat}>
          <dt>{t('settings.assistant.tasksFailed')}</dt>
          <dd className="tabular">{f.number(usage.tasks.failed)}</dd>
        </div>
      </dl>
    </>
  );
}
