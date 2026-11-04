'use client';

import type { Skill, SkillId } from '@jarvis/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import {
  Brain,
  Calendar,
  CalendarCheck,
  CalendarClock,
  CircleCheck,
  CircleDashed,
  FileText,
  Globe,
  Languages,
  Mail,
  Phone,
  PlugZap,
  ShoppingBag,
  Smartphone,
  Workflow,
} from 'lucide-react';
import Link from 'next/link';
import { useId } from 'react';
import { StatusPill } from '@/components/ui/Badge';
import { ErrorBanner } from '@/components/ui/Banner';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/i18n/I18nProvider';
import { skillNameKey } from '@/i18n/server-message';
import { api, type ApiError } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import { cx } from '@/lib/cx';
import { SaveStatus, SettingRow, SettingsCard } from './controls';
import { SettingsSection } from './SettingsSection';
import styles from './settings.module.css';

export const SKILL_ICON: Record<SkillId, LucideIcon> = {
  'web-research': Globe,
  'email-management': Mail,
  'calendar-management': Calendar,
  'appointment-booking': CalendarCheck,
  'phone-calling': Phone,
  'shopping-assistant': ShoppingBag,
  'document-analysis': FileText,
  'task-scheduling': CalendarClock,
  'personal-memory': Brain,
  'device-automation': Smartphone,
  translation: Languages,
  'workflow-planning': Workflow,
};

export function useSkills() {
  return useQuery({
    queryKey: qk.skills,
    queryFn: ({ signal }) => api.call('listSkills', { signal }),
  });
}

/** How many of the switchable skills are on (for the narrow-screen section index). */
export function skillsOnCount(items: readonly Skill[]): { on: number; total: number } {
  const switchable = items.filter((s) => s.canToggle);
  return { on: switchable.filter((s) => s.enabled).length, total: switchable.length };
}

/**
 * Settings › Skills: the backend's skill registry with what is really available for this
 * account — built, needs a connection, or planned — and a switch for each skill that may be
 * turned off. Switching saves at once (PATCH /v1/skills/:id) and shows the server's answer.
 */
export function SkillsSection() {
  const { t } = useI18n();
  const skills = useSkills();
  const plannedId = useId();
  const items = skills.data?.items ?? [];
  const built = items.filter((s) => s.status !== 'planned');
  const planned = items.filter((s) => s.status === 'planned');
  return (
    <SettingsSection
      id="skills"
      title={t('settings.sections.skills')}
      description={t('skills.description')}
    >
      {skills.isPending ? (
        <div className={styles.skeletonCard} aria-busy="true">
          <span className="visually-hidden" role="status">
            {t('skills.loading')}
          </span>
          <Skeleton width="30%" height={14} />
          <Skeleton width="85%" height={12} />
          <Skeleton width="30%" height={14} />
          <Skeleton width="75%" height={12} />
        </div>
      ) : skills.isError && !skills.data ? (
        <ErrorBanner
          title={t('skills.loadError')}
          error={skills.error}
          onRetry={() => void skills.refetch()}
          retrying={skills.isFetching}
        />
      ) : (
        <>
          <SettingsCard>
            {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- list-style: none drops it in Safari */}
            <ul className={styles.skillList} role="list" aria-label={t('skills.listLabel')}>
              {built.map((skill) => (
                <li key={skill.id}>
                  <SkillRow skill={skill} />
                </li>
              ))}
            </ul>
          </SettingsCard>
          {planned.length > 0 && (
            <section className={styles.plannedSkills} aria-labelledby={plannedId}>
              <div className={styles.plannedHead}>
                <h3 id={plannedId} className={styles.rowTitle}>
                  {t('skills.plannedTitle')}
                </h3>
                <p className={styles.rowText}>{t('skills.plannedDescription')}</p>
              </div>
              {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- list-style: none drops it in Safari */}
              <ul className={styles.plannedList} role="list">
                {planned.map((skill) => (
                  <li key={skill.id} className={styles.plannedItem}>
                    <span className={styles.skillIcon} aria-hidden="true">
                      <Icon icon={SKILL_ICON[skill.id]} size={16} />
                    </span>
                    <span className={styles.plannedText}>
                      <span className={styles.plannedName}>{t(skillNameKey(skill.id))}</span>
                      <span className={styles.rowText}>{t(`skills.descriptions.${skill.id}`)}</span>
                    </span>
                    <StatusPill
                      tone="neutral"
                      icon={CircleDashed}
                      label={t('skills.status.planned')}
                      className={styles.plannedPill}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </SettingsSection>
  );
}

function SkillRow({ skill }: { skill: Skill }) {
  const { t, f } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const name = t(skillNameKey(skill.id));
  const save = useMutation<Skill, ApiError, boolean>({
    mutationFn: (enabled) =>
      api.call('updateSkill', { params: { id: skill.id }, body: { enabled } }),
    onSuccess: (next) => {
      queryClient.setQueryData<{ items: Skill[] }>(qk.skills, (prev) =>
        prev ? { items: prev.items.map((s) => (s.id === next.id ? next : s)) } : prev,
      );
      // What JARVIS can do now changed (capabilities); memory mirrors preferences.memory.
      void queryClient.invalidateQueries({ queryKey: qk.assistantStatus });
      void queryClient.invalidateQueries({ queryKey: qk.skills });
      if (next.id === 'personal-memory') void queryClient.invalidateQueries({ queryKey: qk.me });
      toast({
        message: next.enabled ? t('skills.turnedOn', { name }) : t('skills.turnedOff', { name }),
      });
    },
  });

  // Why it can't run now — including "turned off", which says what that means for requests.
  const reason = skill.unavailableReason
    ? skill.unavailableReason === 'CONNECTION_REQUIRED'
      ? t('skills.reasons.CONNECTION_REQUIRED', {
          connections: f.list(skill.requiredConnections.map((c) => t(`skills.connections.${c}`))),
        })
      : t(`skills.reasons.${skill.unavailableReason}`)
    : null;
  const description = (
    <>
      <span className={styles.skillDescription}>{t(`skills.descriptions.${skill.id}`)}</span>
      <span className={styles.skillRisk}>{t(`skills.risk.${skill.maxRisk}`)}</span>
      {/* The model need, unless the reason line already says it is missing right now. */}
      {skill.modelUse === 'required' && skill.unavailableReason !== 'MODEL_REQUIRED' && (
        <span className={styles.skillRisk}>{t('skills.model.required')}</span>
      )}
      {skill.id === 'personal-memory' && (
        <span className={styles.skillRisk}>{t('skills.memoryNote')}</span>
      )}
      {reason && (
        <span className={styles.skillReason}>
          {reason}
          {skill.unavailableReason === 'CONNECTION_REQUIRED' && (
            <>
              {' '}
              <Link href="/connections">{t('skills.connect')}</Link>
            </>
          )}
        </span>
      )}
    </>
  );

  if (!skill.canToggle) {
    // Core skill (workflow-planning): always on, said plainly, no switch.
    return (
      <SettingRow className={styles.skillRow}>
        <div className={styles.skillStatic}>
          <span className={styles.skillIcon} aria-hidden="true">
            <Icon icon={SKILL_ICON[skill.id]} size={16} />
          </span>
          <div className={styles.skillText}>
            <span className={styles.skillName}>{name}</span>
            <p className={styles.rowText}>
              {description}
              <span className={styles.skillRisk}>{t('skills.core')}</span>
            </p>
          </div>
          <StatusPill tone="success" icon={CircleCheck} label={t('skills.status.core')} />
        </div>
      </SettingRow>
    );
  }

  const checked = save.isPending && save.variables !== undefined ? save.variables : skill.enabled;
  return (
    <SettingRow className={styles.skillRow}>
      <div className={styles.skillSwitch}>
        <span className={styles.skillIcon} aria-hidden="true">
          <Icon icon={SKILL_ICON[skill.id]} size={16} />
        </span>
        <Switch
          className={styles.skillSwitchControl}
          checked={checked}
          busy={save.isPending}
          label={
            <span className={styles.skillLabel}>
              {name}
              {skill.status === 'needs_connection' && (
                <StatusPill
                  tone="warning"
                  icon={PlugZap}
                  label={t('skills.status.needsConnection')}
                  className={cx(styles.skillPill)}
                />
              )}
            </span>
          }
          description={description}
          onChange={(next) => {
            if (save.isPending) return;
            save.mutate(next);
          }}
        />
      </div>
      <SaveStatus
        state={save.isPending ? 'saving' : save.isError ? 'error' : 'idle'}
        error={save.error}
      />
    </SettingRow>
  );
}
