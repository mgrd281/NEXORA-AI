'use client';

import type { SessionInfo } from '@jarvis/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { Laptop, LogOut, Monitor, Smartphone, Tablet } from 'lucide-react';
import { useRef } from 'react';
import { Badge } from '@/components/ui/Badge';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonRow } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { UserText } from '@/components/ui/UserText';
import { useI18n, type I18n } from '@/i18n/I18nProvider';
import { api } from '@/lib/api/client';
import { describeError } from '@/lib/api/errors';
import { useSignOut } from '@/lib/api/hooks';
import { qk } from '@/lib/api/query-keys';
import { useSessions } from './api';
import { SettingsCard } from './controls';
import { SettingsSection } from './SettingsSection';
import { summarizeUserAgent } from './userAgent';
import styles from './settings.module.css';

export function SecuritySection() {
  const { t } = useI18n();
  const sessions = useSessions();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const items = sessions.data
    ? [...sessions.data.items].sort(
        (a, b) =>
          Number(b.current) - Number(a.current) ||
          new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime(),
      )
    : [];

  return (
    <SettingsSection
      id="security"
      title={t('settings.sections.security')}
      description={t('settings.security.sessionsDescription')}
    >
      {sessions.isError && !sessions.data ? (
        <ErrorBanner
          error={sessions.error}
          title={t('settings.security.failed')}
          onRetry={() => void sessions.refetch()}
          retrying={sessions.isFetching}
        />
      ) : (
        <SettingsCard>
          <div className={styles.cardHeader}>
            <h3 ref={headingRef} tabIndex={-1} className={styles.rowTitle}>
              {t('settings.security.sessionsTitle')}
            </h3>
          </div>
          {!sessions.data ? (
            <div aria-busy="true">
              <span className="visually-hidden" role="status">
                {t('settings.security.loading')}
              </span>
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : (
            <ul className={styles.sessions}>
              {items.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  onRevoked={() => headingRef.current?.focus({ preventScroll: true })}
                />
              ))}
            </ul>
          )}
        </SettingsCard>
      )}
    </SettingsSection>
  );
}

const PLATFORM_ICON: Record<SessionInfo['platform'], LucideIcon> = {
  web: Monitor,
  ios: Smartphone,
  android: Smartphone,
  macos: Laptop,
};

/** "Chrome on macOS", the native device name, or the platform when nothing better is known. */
export function sessionTitle(session: SessionInfo, t: I18n['t']): string {
  if (session.deviceName?.trim()) return session.deviceName.trim();
  const ua = summarizeUserAgent(session.userAgent);
  if (ua.browser && ua.os)
    return t('settings.security.browserOn', { browser: ua.browser, os: ua.os });
  if (ua.browser) return ua.browser;
  if (ua.os) return ua.os;
  return session.platform === 'web'
    ? t('settings.security.unknownBrowser')
    : t(`settings.security.platforms.${session.platform}`);
}

function sessionIcon(session: SessionInfo): LucideIcon {
  if (session.platform !== 'web') return PLATFORM_ICON[session.platform];
  const kind = summarizeUserAgent(session.userAgent).kind;
  return kind === 'phone' ? Smartphone : kind === 'tablet' ? Tablet : Monitor;
}

function SessionRow({ session, onRevoked }: { session: SessionInfo; onRevoked: () => void }) {
  const i18n = useI18n();
  const { t, f } = i18n;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const signOut = useSignOut();
  const title = sessionTitle(session, t);

  const revoke = useMutation({
    mutationFn: () => api.call('revokeSession', { params: { id: session.id } }),
    onSuccess: () => {
      queryClient.setQueryData<{ items: SessionInfo[] }>(qk.sessions, (prev) =>
        prev ? { items: prev.items.filter((s) => s.id !== session.id) } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: qk.sessions });
      toast({ message: t('settings.security.revoked', { device: title }) });
      onRevoked();
    },
    onError: (error) => toast({ tone: 'error', message: describeError(error, i18n).message }),
  });

  return (
    <li className={styles.session}>
      <span className={styles.sessionIcon}>
        <Icon icon={sessionIcon(session)} size={20} />
      </span>
      <div className={styles.sessionMain}>
        <span className={styles.sessionTitle}>
          <UserText>{title}</UserText>
          {session.current && <Badge>{t('settings.security.thisDevice')}</Badge>}
        </span>
        <span className={styles.sessionMeta}>
          <span>
            {t(`settings.security.platforms.${session.platform}`)}
            {' · '}
            <RelativeTime
              value={session.lastUsedAt}
              format={(time) => t('settings.security.lastActive', { time })}
            />
          </span>
          <span>{t('settings.security.signedIn', { date: f.date(session.createdAt) })}</span>
        </span>
      </div>
      <div className={styles.sessionAction}>
        {session.current ? (
          <Button
            size="sm"
            icon={LogOut}
            mirrorIcons
            loading={signOut.isPending}
            aria-label={t('settings.security.signOutLabel')}
            onClick={() =>
              signOut.mutate(undefined, {
                onError: (error) =>
                  toast({ tone: 'error', message: describeError(error, i18n).message }),
              })
            }
          >
            {signOut.isPending ? t('settings.security.signingOut') : t('settings.security.signOut')}
          </Button>
        ) : (
          <Button
            size="sm"
            loading={revoke.isPending}
            aria-label={t('settings.security.revokeLabel', { device: title })}
            onClick={() => revoke.mutate()}
          >
            {t('settings.security.revoke')}
          </Button>
        )}
      </div>
    </li>
  );
}
