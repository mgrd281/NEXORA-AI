'use client';

import type { Me } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Bot,
  ChevronRight,
  Languages,
  Lock,
  Mic,
  Palette,
  ShieldCheck,
  UserRound,
  Wallet,
} from 'lucide-react';
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { plannerLabel } from '@/components/shell/AssistantStatusLine';
import { Page } from '@/components/shell/Page';
import { ErrorBanner } from '@/components/ui/Banner';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/Skeleton';
import { UserText } from '@/components/ui/UserText';
import { LANGUAGE_NAMES } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';
import { useAssistantStatus, useMe } from '@/lib/api/hooks';
import { useSessions, useUsage } from './api';
import { AppearanceSection } from './AppearanceSection';
import { AssistantSection } from './AssistantSection';
import { NotificationsSection } from './NotificationsSection';
import { PrivacySection } from './PrivacySection';
import { ProfileSection } from './ProfileSection';
import { RegionSection } from './RegionSection';
import { SecuritySection } from './SecuritySection';
import { SETTINGS_SECTIONS, type SettingsSectionId } from './SettingsSection';
import { UsageSection } from './UsageSection';
import { VoiceSection } from './VoiceSection';
import styles from './settings.module.css';

const SECTION_ICONS: Record<SettingsSectionId, LucideIcon> = {
  profile: UserRound,
  language: Languages,
  appearance: Palette,
  voice: Mic,
  assistant: Bot,
  usage: Wallet,
  notifications: Bell,
  security: ShieldCheck,
  privacy: Lock,
};

export function SettingsScreen() {
  const { t } = useI18n();
  const me = useMe();
  return (
    <Page title={t('settings.title')} description={t('settings.description')} width="wide">
      {me.data ? (
        <SettingsBody me={me.data} />
      ) : me.isError ? (
        <ErrorBanner error={me.error} onRetry={() => void me.refetch()} retrying={me.isFetching} />
      ) : (
        <SettingsSkeleton />
      )}
    </Page>
  );
}

function SettingsBody({ me }: { me: Me }) {
  const { t } = useI18n();
  const active = useActiveSection();
  useHashDeepLink();

  function go(e: MouseEvent<HTMLAnchorElement>, id: SettingsSectionId) {
    const section = document.getElementById(id);
    if (!section) return;
    e.preventDefault();
    window.history.replaceState(window.history.state, '', `#${id}`);
    scrollToSection(section, { focus: true });
  }

  return (
    <div className={styles.layout}>
      <SettingsIndex me={me} onGo={go} />
      <nav aria-label={t('settings.navLabel')} className={styles.subnav}>
        <ul className={styles.navList}>
          {SETTINGS_SECTIONS.map((id) => (
            <li key={id}>
              <a
                href={`#${id}`}
                className={styles.navLink}
                aria-current={active === id ? 'true' : undefined}
                onClick={(e) => go(e, id)}
              >
                <Icon icon={SECTION_ICONS[id]} size={16} />
                {t(`settings.sections.${id}`)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className={styles.sections}>
        <ProfileSection me={me} />
        <RegionSection me={me} />
        <AppearanceSection me={me} />
        <VoiceSection me={me} />
        <AssistantSection me={me} />
        <UsageSection me={me} />
        <NotificationsSection me={me} />
        <SecuritySection />
        <PrivacySection />
      </div>
    </div>
  );
}

/**
 * Below 1024 px: every section as one row with its current value and a chevron, under the
 * title (the iOS Settings pattern), so the first screen of a phone shows all of Settings.
 * Each row jumps to its section like the side navigation does on wide screens.
 */
function SettingsIndex({
  me,
  onGo,
}: {
  me: Me;
  onGo: (e: MouseEvent<HTMLAnchorElement>, id: SettingsSectionId) => void;
}) {
  const { t, f } = useI18n();
  const status = useAssistantStatus();
  const usage = useUsage();
  const sessions = useSessions();
  const prefs = me.preferences;
  const notifications = Object.values(prefs.notifications);

  const values: Record<SettingsSectionId, ReactNode> = {
    profile: <UserText>{me.displayName}</UserText>,
    language: LANGUAGE_NAMES[me.locale],
    appearance: t(`common.theme.${me.theme}`),
    voice: prefs.voice.speakResponses ? t('settings.index.voiceOn') : t('settings.index.voiceOff'),
    assistant: plannerLabel(status.data, t),
    usage: usage.data
      ? usage.data.budgetMicroUsd > 0
        ? t('settings.assistant.usageSpent', {
            // Arabic currency output starts with a right-to-left mark; keep each amount LTR.
            spent: `\u2066${f.currency(usage.data.aiMicroUsd)}\u2069`,
            budget: `\u2066${f.currency(usage.data.budgetMicroUsd)}\u2069`,
          })
        : t('settings.index.paidOff')
      : null,
    notifications: t('settings.index.notificationsOn', {
      on: notifications.filter(Boolean).length,
      total: notifications.length,
    }),
    security: sessions.data
      ? t('settings.index.devices', { count: sessions.data.items.length })
      : null,
    privacy: prefs.memory.enabled ? t('settings.index.memoryOn') : t('settings.index.memoryOff'),
  };

  return (
    <nav aria-label={t('settings.navLabel')} className={styles.index}>
      <ul className={styles.indexList}>
        {SETTINGS_SECTIONS.map((id) => (
          <li key={id}>
            <a href={`#${id}`} className={styles.indexLink} onClick={(e) => onGo(e, id)}>
              <span className={styles.indexIcon}>
                <Icon icon={SECTION_ICONS[id]} size={20} />
              </span>
              <span className={styles.indexLabel}>{t(`settings.sections.${id}`)}</span>
              {values[id] && <span className={styles.indexValue}>{values[id]}</span>}
              <span className={styles.indexChevron}>
                <Icon icon={ChevronRight} size={16} mirror />
              </span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Scrolls a section into view. From the sub-navigation, focus also moves to the section heading
 * so keyboard and screen-reader users continue there; a deep link on load only scrolls, like
 * native hash navigation.
 */
function scrollToSection(section: HTMLElement, { focus }: { focus: boolean }) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  section.scrollIntoView({ behavior: focus && !reduce ? 'smooth' : 'auto', block: 'start' });
  const heading = section.querySelector<HTMLElement>('h2');
  if (focus && heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

/** /settings#assistant (e.g. from the sidebar status line) lands on that section once rendered. */
function useHashDeepLink() {
  useEffect(() => {
    function jump() {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!(SETTINGS_SECTIONS as readonly string[]).includes(id)) return;
      const section = document.getElementById(id);
      if (section) scrollToSection(section, { focus: false });
    }
    // After the first paint of the loaded settings, so the layout above the anchor is final.
    const frame = requestAnimationFrame(jump);
    window.addEventListener('hashchange', jump);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('hashchange', jump);
    };
  }, []);
}

/** The section currently at the top of the viewport (scroll spy for the sub-navigation). */
function useActiveSection(): SettingsSectionId {
  const [active, setActive] = useState<SettingsSectionId>('profile');
  useEffect(() => {
    let frame = 0;
    function update() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const atBottom =
          window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
        if (atBottom) {
          setActive(SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1]!);
          return;
        }
        const line = window.innerHeight * 0.25;
        let current: SettingsSectionId = SETTINGS_SECTIONS[0];
        for (const id of SETTINGS_SECTIONS) {
          const el = document.getElementById(id);
          if (el && el.getBoundingClientRect().top <= line) current = id;
        }
        setActive(current);
      });
    }
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return active;
}

function SettingsSkeleton() {
  const { t } = useI18n();
  return (
    <div className={styles.sections} aria-busy="true">
      <span className="visually-hidden" role="status">
        {t('settings.loading')}
      </span>
      {[0, 1].map((i) => (
        <div key={i} className={styles.stack}>
          <Skeleton width={140} height={22} />
          <div className={styles.skeletonCard}>
            <Skeleton width="30%" height={14} />
            <Skeleton width="100%" height={40} radius="md" />
            <Skeleton width="55%" height={12} />
          </div>
        </div>
      ))}
    </div>
  );
}
