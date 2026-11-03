'use client';

import type { AssistantStatus, Me } from '@jarvis/contracts';
import { Bell, ChevronsUpDown } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ComposerRegistryProvider,
  useComposerRegistry,
} from '@/components/composer/ComposerRegistry';
import { deriveAssistantPresence, type PresenceDescriptor } from '@/components/presence/model';
import { Presence } from '@/components/presence/Presence';
import { Avatar } from '@/components/ui/Avatar';
import { Banner } from '@/components/ui/Banner';
import { IconButton } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Popover, PopoverAnchor } from '@/components/ui/Popover';
import { UserText } from '@/components/ui/UserText';
import { useI18n } from '@/i18n/I18nProvider';
import { useAssistantStatus, useHome, useMe } from '@/lib/api/hooks';
import { cx } from '@/lib/cx';
import {
  EventStreamProvider,
  useEventStreamStatus,
  useStreamEvent,
} from '@/lib/events/EventStreamProvider';
import { useDelayedFlag } from '@/lib/hooks/useDelayedFlag';
import { useOnline } from '@/lib/hooks/useOnline';
import { singleKeyShortcutsEnabled, useApplyAppearance } from '@/lib/preferences';
import { AccountMenuItems } from './AccountMenu';
import styles from './AppShell.module.css';
import { AssistantStatusLine } from './AssistantStatusLine';
import { ADMIN_NAV, isActive, PRIMARY_NAV, sectionFor, type NavItem } from './nav';
import { NotificationsPanel } from './NotificationsPanel';
import { ShellContext, type ShellState } from './ShellContext';
import { ShortcutsDialog } from './ShortcutsDialog';
import { useSpeakVoiceResults } from '@/features/tasks/useSpeakVoiceResults';

/**
 * The authenticated app frame: start-side sidebar from 900 px, top bar + bottom tab bar below.
 * Owns the realtime stream, the assistant-wide Presence, the cookie mirror of locale/theme and
 * the keyboard shortcuts (⌘/Ctrl+K → composer, from any page; '/' → this page's composer;
 * '?' → shortcuts; the single-key ones can be turned off).
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <EventStreamProvider>
      <ComposerRegistryProvider>
        <ShellFrame>{children}</ShellFrame>
      </ComposerRegistryProvider>
    </EventStreamProvider>
  );
}

const FLASH_MS = { completed: 3200, failed: 4500 } as const;

function ShellFrame({ children }: { children: ReactNode }) {
  const { t, setTimeZone } = useI18n();
  const pathname = usePathname();
  const me = useMe();
  const home = useHome();
  const status = useAssistantStatus();
  const stream = useEventStreamStatus();
  const online = useOnline();
  const registry = useComposerRegistry();
  const applyAppearance = useApplyAppearance();
  // Read voice-initiated results aloud on every screen (honours preferences.voice.speakResponses).
  useSpeakVoiceResults();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [flash, setFlash] = useState<'completed' | 'failed' | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);

  // Mirror the profile's locale/theme into cookies (server-rendered lang/dir/theme) and use the
  // account's time zone for every date.
  const meData = me.data;
  useEffect(() => {
    if (!meData) return;
    applyAppearance({ locale: meData.locale, theme: meData.theme });
    setTimeZone(meData.timeZone);
  }, [meData, applyAppearance, setTimeZone]);

  // A task reaching COMPLETED / FAILED shows briefly on the Presence (a real, live event).
  useStreamEvent(
    (event) => {
      const to = event.data.to;
      if (to !== 'COMPLETED' && to !== 'FAILED') return;
      const kind = to === 'COMPLETED' ? 'completed' : 'failed';
      setFlash(kind);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS[kind]);
    },
    ['task.status_changed'],
  );
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  // 'closed' = the stream failed before it ever opened (API unreachable); it retries with backoff.
  const reconnecting = useDelayedFlag(stream === 'reconnecting' || stream === 'closed', 3000);
  const workerHealthy = status.data?.worker.healthy ?? home.data?.assistant.worker.healthy ?? null;
  const pendingApprovals = home.data?.pendingApprovals.length ?? 0;
  const unreadNotifications = home.data?.unreadNotifications ?? 0;
  const isAdmin = meData?.roles.includes('platform_admin') ?? false;

  const presence = deriveAssistantPresence({
    online,
    stream: reconnecting ? 'reconnecting' : stream,
    workerHealthy,
    activeTasks: home.data?.activeTasks ?? [],
    pendingApprovals,
    flash,
    listening,
  });

  // Keyboard shortcuts.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        if (document.querySelector('dialog[open]')) return;
        e.preventDefault();
        registry?.focusComposer();
        return;
      }
      if (mod || e.altKey || isTypingTarget(e.target) || document.querySelector('dialog[open]'))
        return;
      // Single-key shortcuts can be turned off in the shortcuts dialog (WCAG 2.1.4).
      if (!singleKeyShortcutsEnabled()) return;
      if (e.key === '/') {
        // Only where this page has a request field: '/' never navigates.
        if (registry?.focusComposerHere()) e.preventDefault();
      } else if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [registry]);

  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const shell = useMemo<ShellState>(
    () => ({
      presence,
      pendingApprovals,
      unreadNotifications,
      isAdmin,
      setListening,
      openShortcuts,
    }),
    [presence, pendingApprovals, unreadNotifications, isAdmin, openShortcuts],
  );
  const presenceLabel = t(presence.labelKey, presence.labelParams);

  return (
    <ShellContext.Provider value={shell}>
      <a href="#main" className={styles.skipLink}>
        {t('common.a11y.skipToContent')}
      </a>
      <div className={styles.shell}>
        <Sidebar
          pathname={pathname}
          presence={presence}
          presenceLabel={presenceLabel}
          me={meData}
          status={status.data}
          pendingApprovals={pendingApprovals}
          unread={unreadNotifications}
          isAdmin={isAdmin}
          onShortcuts={openShortcuts}
        />
        <MobileTopBar
          pathname={pathname}
          presence={presence}
          presenceLabel={presenceLabel}
          me={meData}
          unread={unreadNotifications}
          isAdmin={isAdmin}
          onShortcuts={openShortcuts}
        />
        <main id="main" tabIndex={-1} className={styles.main}>
          <ShellBanners online={online} reconnecting={reconnecting} workerHealthy={workerHealthy} />
          {children}
        </main>
        <TabBar pathname={pathname} pendingApprovals={pendingApprovals} />
      </div>
      {/* One polite announcement per Presence change (the rings themselves are aria-hidden). */}
      <span className="visually-hidden" role="status" aria-live="polite">
        {presenceLabel}
      </span>
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </ShellContext.Provider>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

function ShellBanners({
  online,
  reconnecting,
  workerHealthy,
}: {
  online: boolean;
  reconnecting: boolean;
  workerHealthy: boolean | null;
}) {
  const { t } = useI18n();
  if (!online)
    return (
      <Banner tone="warning" live title={t('shell.banners.offline')} className={styles.banner} />
    );
  if (workerHealthy === false)
    return (
      <Banner
        tone="warning"
        live
        title={t('shell.banners.unavailable')}
        className={styles.banner}
      />
    );
  if (reconnecting)
    return (
      <Banner tone="info" live title={t('shell.banners.reconnecting')} className={styles.banner} />
    );
  return null;
}

function NavLink({
  item,
  pathname,
  badge,
  badgeLabel,
}: {
  item: NavItem;
  pathname: string;
  badge?: number;
  badgeLabel?: string;
}) {
  const { t } = useI18n();
  const active = isActive(item, pathname);
  const label = t(item.label);
  return (
    <Link
      href={item.href}
      className={styles.navItem}
      aria-current={active ? 'page' : undefined}
      data-active={active || undefined}
    >
      <Icon icon={item.icon} size={20} />
      {/* Named by its content ("Tasks, 1 approval waiting"): the visible count is decoration and
          the hidden suffix says what it counts. */}
      <span className={styles.navLabel}>{label}</span>
      {badge ? (
        <>
          <span className={cx(styles.navCount, 'tabular')} aria-hidden="true">
            {badge}
          </span>
          {badgeLabel && <span className="visually-hidden">{`, ${badgeLabel}`}</span>}
        </>
      ) : null}
    </Link>
  );
}

function Sidebar({
  pathname,
  presence,
  presenceLabel,
  me,
  status,
  pendingApprovals,
  unread,
  isAdmin,
  onShortcuts,
}: {
  pathname: string;
  presence: PresenceDescriptor;
  presenceLabel: string;
  me: Me | undefined;
  status: AssistantStatus | undefined;
  pendingApprovals: number;
  unread: number;
  isAdmin: boolean;
  onShortcuts: () => void;
}) {
  const { t } = useI18n();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const bellRef = useRef<HTMLButtonElement>(null);
  const accountRef = useRef<HTMLButtonElement>(null);
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <Link href="/" className={styles.brandLink} aria-label={t('shell.brand')}>
          {/* The lockup is a mark: ring before wordmark in every direction; only its place
              in the sidebar mirrors. */}
          <span className={styles.lockup} dir="ltr">
            <Presence
              state={presence.state}
              progress={presence.progress}
              size={24}
              label={presenceLabel}
            />
            <span className={styles.wordmark} aria-hidden="true" translate="no">
              {t('common.appName')}
            </span>
          </span>
        </Link>
      </div>

      <nav aria-label={t('shell.nav.label')} className={styles.nav}>
        <ul className={styles.navList}>
          {PRIMARY_NAV.map((item) => (
            <li key={item.key}>
              <NavLink
                item={item}
                pathname={pathname}
                badge={item.key === 'tasks' ? pendingApprovals : undefined}
                badgeLabel={
                  item.key === 'tasks' && pendingApprovals > 0
                    ? t('shell.tasksBadge', { count: pendingApprovals })
                    : undefined
                }
              />
            </li>
          ))}
        </ul>
      </nav>

      <div className={styles.footer}>
        {isAdmin && <NavLink item={ADMIN_NAV} pathname={pathname} />}
        <PopoverAnchor>
          <button
            ref={bellRef}
            type="button"
            className={styles.navItem}
            aria-haspopup="dialog"
            aria-expanded={notificationsOpen}
            onClick={() => setNotificationsOpen((v) => !v)}
          >
            <Icon icon={Bell} size={20} />
            {/* "Notifications, 9 unread": the visible label once, then only the count. */}
            <span className={styles.navLabel}>{t('notifications.title')}</span>
            {unread > 0 && (
              <>
                <span
                  className={cx(styles.navCount, styles.unreadCount, 'tabular')}
                  aria-hidden="true"
                >
                  {unread}
                </span>
                <span className="visually-hidden">
                  {t('notifications.unreadSuffix', { count: unread })}
                </span>
              </>
            )}
          </button>
          <Popover
            open={notificationsOpen}
            onClose={() => setNotificationsOpen(false)}
            triggerRef={bellRef}
            label={t('notifications.title')}
            placement="end"
            width={380}
          >
            <NotificationsPanel onNavigate={() => setNotificationsOpen(false)} />
          </Popover>
        </PopoverAnchor>

        <div className={styles.divider} />

        <PopoverAnchor>
          <button
            ref={accountRef}
            type="button"
            className={styles.account}
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            onClick={() => setAccountOpen((v) => !v)}
          >
            <Avatar name={me?.displayName ?? ''} size={32} />
            <span className={styles.accountText}>
              <UserText className={styles.accountName}>{me?.displayName ?? '\u00a0'}</UserText>
              <span className={styles.accountEmail}>{me?.email ?? '\u00a0'}</span>
            </span>
            <Icon icon={ChevronsUpDown} size={16} className={styles.accountChevron} />
          </button>
          <Popover
            open={accountOpen}
            onClose={() => setAccountOpen(false)}
            triggerRef={accountRef}
            label={t('shell.account.menu')}
            placement="end"
            role="menu"
            initialFocus="first"
            width={260}
          >
            <AccountMenuItems
              me={me}
              showAdmin={false}
              onClose={() => setAccountOpen(false)}
              onShortcuts={onShortcuts}
            />
          </Popover>
        </PopoverAnchor>
        <AssistantStatusLine status={status} />
      </div>
    </aside>
  );
}

function MobileTopBar({
  pathname,
  presence,
  presenceLabel,
  me,
  unread,
  isAdmin,
  onShortcuts,
}: {
  pathname: string;
  presence: PresenceDescriptor;
  presenceLabel: string;
  me: Me | undefined;
  unread: number;
  isAdmin: boolean;
  onShortcuts: () => void;
}) {
  const { t, dir } = useI18n();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLButtonElement>(null);
  const section = sectionFor(pathname);
  const headingScrolledAway = useMainHeadingScrolledAway(pathname);
  return (
    <header className={styles.topbar}>
      {/* The lockup (ring before wordmark) never mirrors; only its place in the bar does. */}
      <div className={styles.topStart} dir="ltr">
        <Presence
          state={presence.state}
          progress={presence.progress}
          size={24}
          label={presenceLabel}
        />
        {/* Wordmark at rest; the section title once the page's h1 scrolls under the bar. */}
        <span className={styles.topLabels} aria-hidden="true">
          <span
            className={styles.topBrand}
            data-visible={!headingScrolledAway || undefined}
            translate="no"
          >
            {t('common.appName')}
          </span>
          <span
            className={styles.topTitle}
            data-visible={headingScrolledAway || undefined}
            dir={dir}
          >
            {t(section.label)}
          </span>
        </span>
      </div>
      <div className={styles.topEnd}>
        <IconButton
          label={t('notifications.button', { count: unread })}
          icon={Bell}
          tooltip="none"
          badge={unread > 0 ? (unread > 9 ? '9+' : unread) : undefined}
          aria-haspopup="dialog"
          onClick={() => setNotificationsOpen(true)}
        />
        <PopoverAnchor>
          <button
            ref={accountRef}
            type="button"
            className={styles.avatarButton}
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            onClick={() => setAccountOpen((v) => !v)}
          >
            <Avatar name={me?.displayName ?? ''} size={32} />
            <span className="visually-hidden">
              {me ? `${t('shell.account.menu')}: ${me.displayName}` : t('shell.account.menu')}
            </span>
          </button>
          <Popover
            open={accountOpen}
            onClose={() => setAccountOpen(false)}
            triggerRef={accountRef}
            label={t('shell.account.menu')}
            placement="bottom-end"
            role="menu"
            initialFocus="first"
            width={280}
          >
            <AccountMenuItems
              me={me}
              showAdmin={isAdmin}
              onClose={() => setAccountOpen(false)}
              onShortcuts={onShortcuts}
            />
          </Popover>
        </PopoverAnchor>
      </div>
      <Sheet
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        title={t('notifications.title')}
        className={styles.notificationsSheet}
      >
        <NotificationsPanel onNavigate={() => setNotificationsOpen(false)} showTitle={false} />
      </Sheet>
    </header>
  );
}

/** True once the main content's h1 has scrolled under the mobile top bar. */
function useMainHeadingScrolledAway(pathname: string): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const main = document.getElementById('main');
    if (!main || typeof IntersectionObserver === 'undefined') return;
    let observed: Element | null = null;
    let io: IntersectionObserver | null = null;
    const attach = () => {
      const heading = main.querySelector('h1');
      if (heading === observed) return;
      io?.disconnect();
      observed = heading;
      if (!heading) {
        setAway(false);
        return;
      }
      io = new IntersectionObserver(([entry]) => setAway(entry ? !entry.isIntersecting : false), {
        rootMargin: '-60px 0px 0px 0px',
      });
      io.observe(heading);
    };
    const mo = new MutationObserver(attach);
    mo.observe(main, { childList: true, subtree: true });
    const frame = requestAnimationFrame(attach);
    return () => {
      cancelAnimationFrame(frame);
      mo.disconnect();
      io?.disconnect();
    };
  }, [pathname]);
  return away;
}

function TabBar({ pathname, pendingApprovals }: { pathname: string; pendingApprovals: number }) {
  const { t } = useI18n();
  return (
    <nav aria-label={t('shell.nav.label')} className={styles.tabbar} data-tabbar="">
      <ul className={styles.tabList}>
        {PRIMARY_NAV.map((item) => {
          const active = isActive(item, pathname);
          const badge = item.key === 'tasks' && pendingApprovals > 0 ? pendingApprovals : 0;
          return (
            <li key={item.key} className={styles.tabItem}>
              <Link
                href={item.href}
                className={styles.tab}
                aria-current={active ? 'page' : undefined}
                data-active={active || undefined}
              >
                <span className={styles.tabIcon}>
                  <Icon icon={item.icon} size={24} />
                  {badge > 0 && (
                    <span className={cx(styles.tabBadge, 'tabular')} aria-hidden="true">
                      {badge > 9 ? '9+' : badge}
                    </span>
                  )}
                </span>
                <span className={styles.tabLabel}>{t(item.label)}</span>
                {badge > 0 && (
                  <span className="visually-hidden">
                    {`, ${t('shell.tasksBadge', { count: badge })}`}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
