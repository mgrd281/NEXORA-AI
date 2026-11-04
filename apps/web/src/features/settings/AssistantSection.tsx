'use client';

import type { AssistantStatus, Me } from '@jarvis/contracts';
import { CircleCheck, CircleMinus, Info } from 'lucide-react';
import Link from 'next/link';
import { useId } from 'react';
import { plannerLabel } from '@/components/shell/AssistantStatusLine';
import { ErrorBanner } from '@/components/ui/Banner';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Skeleton } from '@/components/ui/Skeleton';
import { useI18n } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/catalog';
import { useAssistantStatus } from '@/lib/api/hooks';
import { cx } from '@/lib/cx';
import { PreferenceSwitch, SettingsCard } from './controls';
import { SettingsSection } from './SettingsSection';
import styles from './settings.module.css';

export function AssistantSection({ me }: { me: Me }) {
  const { t } = useI18n();
  const status = useAssistantStatus();
  // Without a model key on the server, the model switch is stored but changes nothing yet.
  const noModel = status.data?.planner.reason === 'NO_API_KEY';
  return (
    <SettingsSection id="assistant" title={t('settings.sections.assistant')}>
      <AssistantStatusCard budgetUsd={me.preferences.spending.monthlyAiBudgetUsd} />
      <SettingsCard>
        <PreferenceSwitch
          me={me}
          label={t('settings.assistant.externalModels')}
          description={
            <>
              {t('settings.assistant.externalModelsDescription')}
              {noModel && (
                <span className={styles.inactiveNote}>
                  <Icon icon={Info} size={16} />
                  <span>{t('settings.assistant.externalModelsInactive')}</span>
                </span>
              )}
            </>
          }
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
  attachments: null,
  translation: null,
  schedules: '/settings#skills',
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
                  // Phase B capabilities are absent on older servers: say nothing about them.
                  if (on === undefined) return null;
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
