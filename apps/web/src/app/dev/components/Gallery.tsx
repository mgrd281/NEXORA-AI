'use client';

import type { ThemePreference } from '@jarvis/contracts';
import {
  ArrowRight,
  Bell,
  Brain,
  ChevronDown,
  Globe,
  Inbox,
  Mail,
  Plus,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { ApprovalSheet } from '@/components/approvals/ApprovalSheet';
import { CommandComposer } from '@/components/composer/CommandComposer';
import { Presence, type PresenceSize } from '@/components/presence/Presence';
import type { PresenceState } from '@/components/presence/model';
import { ShortcutsDialog } from '@/components/shell/ShortcutsDialog';
import { TaskRow } from '@/components/tasks/TaskRow';
import { StepStatusPill, TaskStatusPill } from '@/components/tasks/TaskStatusPill';
import { Avatar } from '@/components/ui/Avatar';
import { Badge, RiskBadge } from '@/components/ui/Badge';
import { Banner, ErrorBanner } from '@/components/ui/Banner';
import { Button, ButtonLink, IconButton } from '@/components/ui/Button';
import { Card, Section } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { Dialog, Sheet } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select, TextArea, TextField } from '@/components/ui/Field';
import { Kbd } from '@/components/ui/Kbd';
import { ListGroup, ListRow } from '@/components/ui/ListRow';
import { Money } from '@/components/ui/Money';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton, SkeletonRow } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { VoiceMode } from '@/components/voice/VoiceMode';
import type { Messages } from '@/i18n/catalog';
import { dirFor, LANGUAGE_NAMES, LOCALES, type Locale } from '@/i18n/config';
import { I18nProvider, useI18n } from '@/i18n/I18nProvider';
import { ApiError } from '@/lib/api/client';
import { applyTheme, readCookie } from '@/lib/preferences';
import styles from './gallery.module.css';
import { sampleApproval, sampleTasks } from './samples';

const PRESENCE_STATES: PresenceState[] = [
  'idle',
  'listening',
  'thinking',
  'running',
  'awaiting',
  'completed',
  'failed',
  'reconnecting',
  'offline',
];
const SIZES: PresenceSize[] = [16, 24, 40, 96];

const subscribeNoop = () => () => undefined;

export function Gallery({
  catalogs,
  initialLocale,
}: {
  catalogs: Record<Locale, Messages>;
  initialLocale: Locale;
}) {
  // Client-only: samples use the current time, which must not differ between server and client.
  const mounted = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [theme, setTheme] = useState<ThemePreference>(() => {
    const stored = typeof document === 'undefined' ? null : readCookie('jarvis_theme');
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  });
  if (!mounted) return null;
  return (
    <I18nProvider locale={locale} messages={catalogs[locale]}>
      <div lang={locale} dir={dirFor(locale)} className={styles.root}>
        <header className={styles.toolbar}>
          <h1 className={styles.heading}>Meridian components</h1>
          <div className={styles.toolbarControls}>
            <SegmentedControl
              legend="Theme"
              size="sm"
              value={theme}
              onChange={(v) => {
                setTheme(v);
                applyTheme(v);
              }}
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
            <SegmentedControl
              legend="Language"
              size="sm"
              value={locale}
              onChange={setLocale}
              options={LOCALES.map((l) => ({ value: l, label: LANGUAGE_NAMES[l] }))}
            />
          </div>
        </header>
        <GalleryBody />
      </div>
    </I18nProvider>
  );
}

function Demo({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <Card className={wide ? styles.wideCard : undefined}>
      <Section title={title} headingLevel={2}>
        {children}
      </Section>
    </Card>
  );
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      {label && <span className={styles.rowLabel}>{label}</span>}
      <div className={styles.rowItems}>{children}</div>
    </div>
  );
}

function GalleryBody() {
  const { t, f } = useI18n();
  const { toast } = useToast();
  const [now] = useState(() => Date.now());
  const [switchOn, setSwitchOn] = useState(true);
  const [segment, setSegment] = useState<'all' | 'active' | 'failed'>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [destructiveOpen, setDestructiveOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const tasks = sampleTasks(now);
  const approval = sampleApproval(now);
  const sampleError = new ApiError(
    'CONNECTION_FAILED',
    'The mail server rejected the username or password.',
    422,
    'req_7f3a9c1e2b',
  );

  return (
    <div className={styles.grid}>
      <Demo title="Presence" wide>
        <div className={styles.presenceGrid}>
          {PRESENCE_STATES.map((state) => (
            <div key={state} className={styles.presenceCell}>
              <div className={styles.presenceSizes}>
                {SIZES.map((size) => (
                  <Presence
                    key={size}
                    state={state}
                    size={size}
                    progress={{ completed: 2, total: 3 }}
                    level={state === 'listening' ? 0.55 : 0}
                  />
                ))}
              </div>
              <Presence
                state={state}
                size={16}
                showLabel
                progress={{ completed: 2, total: 3 }}
                label={`${state} — ${t(`common.presence.${state === 'running' ? 'running' : state}`)}`}
              />
            </div>
          ))}
        </div>
        <Row label="Running progress 0 → 3 of 3">
          {[0, 1, 2, 3].map((n) => (
            <Presence key={n} state="running" size={40} progress={{ completed: n, total: 3 }} />
          ))}
        </Row>
        <Row label="Listening level 0 → 1">
          {[0, 0.25, 0.5, 0.75, 1].map((level) => (
            <Presence key={level} state="listening" size={40} level={level} />
          ))}
        </Row>
      </Demo>

      <Demo title="Buttons">
        {(['primary', 'secondary', 'ghost', 'danger', 'destructive'] as const).map((variant) => (
          <Row key={variant} label={variant}>
            <Button variant={variant} size="sm">
              {t('common.actions.save')}
            </Button>
            <Button variant={variant} icon={Plus}>
              {t('common.actions.continue')}
            </Button>
            <Button variant={variant} size="lg">
              {t('approvals.approve.email')}
            </Button>
            <Button variant={variant} disabled>
              {t('common.actions.edit')}
            </Button>
            <Button variant={variant} loading>
              {t('common.status.saving')}
            </Button>
          </Row>
        ))}
        <Row label="Link and directional icon">
          <ButtonLink href="/tasks" iconEnd={ArrowRight} mirrorIcons>
            {t('shell.nav.tasks')}
          </ButtonLink>
          <Button variant="ghost" iconEnd={ChevronDown}>
            {t('common.actions.showDetails')}
          </Button>
        </Row>
      </Demo>

      <Demo title="Icon buttons">
        <Row label="Variants">
          <IconButton label={t('common.actions.copy')} icon={Plus} />
          <IconButton label={t('shell.nav.settings')} icon={Settings} variant="secondary" />
          <IconButton
            label={t('composer.send')}
            icon={ArrowRight}
            variant="primary"
            shape="round"
            mirror
          />
          <IconButton label={t('notifications.title')} icon={Bell} badge={3} />
        </Row>
        <Row label="Sizes">
          <IconButton label="sm" icon={Inbox} size="sm" />
          <IconButton label="md" icon={Inbox} size="md" />
          <IconButton label="lg" icon={Inbox} size="lg" />
        </Row>
        <Row label="States">
          <IconButton label={t('common.actions.delete')} icon={Trash2} disabled />
          <IconButton label={t('common.status.loading')} icon={Inbox} loading />
          <CopyButton value="sha256:5d2f8c1a9e3b" label="SHA-256" />
        </Row>
        <p className={styles.note}>Hover or focus an icon button to see its tooltip.</p>
      </Demo>

      <Demo title="Text fields">
        <TextField
          label={t('auth.email')}
          placeholder="layla.haddad@example.com"
          type="email"
          dir="ltr"
        />
        <TextField
          label={t('auth.password')}
          hint="At least 12 characters."
          type="password"
          defaultValue="correct horse"
          dir="ltr"
        />
        <TextField
          label="SMTP host"
          defaultValue="smtp"
          error={t('errors.codes.CONNECTION_FAILED')}
          dir="ltr"
        />
        <TextField label={t('settings.language')} defaultValue="Read-only" disabled />
        <TextArea
          label={t('approvals.note.label')}
          hint={t('approvals.note.hint')}
          placeholder={t('composer.placeholder')}
          rows={2}
        />
        <Select label={t('voice.language')} defaultValue="en-US">
          <option value="en-US">{t('voice.languages.enUS')}</option>
          <option value="de-DE">{t('voice.languages.deDE')}</option>
          <option value="ar-SA">{t('voice.languages.arSA')}</option>
        </Select>
      </Demo>

      <Demo title="Switch and segmented control">
        <Switch
          checked={switchOn}
          onChange={setSwitchOn}
          label="Send emails to myself without asking"
          description="Only emails addressed to your own address, never to anyone else."
        />
        <Switch checked={false} onChange={() => undefined} label={t('settings.sections.privacy')} />
        <Switch checked onChange={() => undefined} label={t('common.status.saving')} disabled />
        <SegmentedControl
          legend={t('tasks.title')}
          showLegend
          value={segment}
          onChange={setSegment}
          options={[
            { value: 'all', label: t('tasks.filters.all') },
            { value: 'active', label: t('tasks.filters.active') },
            { value: 'failed', label: t('tasks.filters.failed') },
          ]}
        />
      </Demo>

      <Demo title="Badges, status and risk">
        <Row label="Tones">
          <Badge>Neutral</Badge>
          <Badge tone="accent" icon={Sparkles}>
            Accent
          </Badge>
          <Badge tone="success">Success</Badge>
          <Badge tone="warning">Warning</Badge>
          <Badge tone="danger">Danger</Badge>
        </Row>
        <Row label="Task status">
          {(
            [
              'QUEUED',
              'PLANNING',
              'AWAITING_APPROVAL',
              'RUNNING',
              'VERIFYING',
              'COMPLETED',
              'FAILED',
              'CANCELLED',
              'EXPIRED',
            ] as const
          ).map((s) => (
            <TaskStatusPill key={s} status={s} />
          ))}
        </Row>
        <Row label="Step status">
          {(
            [
              'PENDING',
              'AWAITING_APPROVAL',
              'RUNNING',
              'SUCCEEDED',
              'FAILED',
              'SKIPPED',
              'CANCELLED',
              'BLOCKED',
            ] as const
          ).map((s) => (
            <StepStatusPill key={s} status={s} />
          ))}
        </Row>
        <Row label="Risk">
          {(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const).map((r) => (
            <RiskBadge key={r} level={r} label={t(`common.risk.${r}`)} />
          ))}
        </Row>
      </Demo>

      <Demo title="List rows">
        <Card padding="none">
          <ListGroup>
            <ListRow
              leading={<Avatar name="Layla Haddad" />}
              title="Layla Haddad"
              description="layla.haddad@example.com"
              href="/settings"
            />
            <ListRow
              leading={<Globe size={20} strokeWidth={1.75} aria-hidden="true" />}
              title={t('connections.web.title')}
              description={t('connections.status.active')}
              meta={<RelativeTime value={now - 3 * 86_400_000} />}
              onClick={() => toast({ message: t('connections.status.active') })}
            />
            <ListRow
              leading={<Mail size={20} strokeWidth={1.75} aria-hidden="true" />}
              title={t('connections.email.title')}
              description={t('connections.status.notConnected')}
            />
          </ListGroup>
        </Card>
      </Demo>

      <Demo title="Task rows" wide>
        <Card padding="none">
          <ul className={styles.taskList}>
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} onReviewApproval={() => setApprovalOpen(true)} />
            ))}
          </ul>
        </Card>
      </Demo>

      <Demo title="Empty, loading">
        <Card padding="none">
          <EmptyState
            icon={Brain}
            message={t('memory.empty')}
            action={<Button icon={Plus}>{t('common.actions.continue')}</Button>}
          />
        </Card>
        <Card padding="none">
          <div aria-busy="true">
            <span className="visually-hidden" role="status">
              {t('common.status.loading')}
            </span>
            <SkeletonRow />
            <SkeletonRow />
          </div>
        </Card>
        <Row label="Skeleton and spinner">
          <Skeleton width={120} height={12} />
          <Skeleton width={40} height={40} radius="full" />
          <Spinner size={16} />
          <Spinner size={20} />
          <Spinner size={24} label={t('common.status.loading')} />
        </Row>
      </Demo>

      <Demo title="Banners">
        <Banner tone="info" title={t('common.assistant.offlinePlanner')}>
          {t('common.assistant.reasons.NO_API_KEY')}
        </Banner>
        <Banner tone="success" title={t('approvals.results.approved')} />
        <Banner tone="warning" title={t('shell.banners.unavailable')} />
        <Banner
          tone="danger"
          title={t('errors.codes.OUTCOME_UNKNOWN')}
          action={<Button size="sm">{t('common.actions.retry')}</Button>}
        />
        <ErrorBanner error={sampleError} onRetry={() => undefined} />
      </Demo>

      <Demo title="Text, time, money, avatars">
        <Row label="Keys">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
          <Kbd>{t('composer.keyShift')}</Kbd>
          <Kbd>{t('composer.keyEnter')}</Kbd>
          <Kbd>Esc</Kbd>
        </Row>
        <Row label="Relative time">
          <RelativeTime value={now - 5 * 60_000} />
          <RelativeTime
            value={now + 3 * 3_600_000}
            format={(time) => t('approvals.expires', { time })}
          />
          <RelativeTime value={now - 26 * 3_600_000} />
        </Row>
        <Row label="Money">
          <Money microUsd={0} />
          <Money microUsd={4_200} />
          <Money microUsd={1_250_000} />
          <Money microUsd={123_456_789} />
        </Row>
        <Row label="Numbers">
          <span className="tabular">{f.number(1234567)}</span>
          <span className="tabular">{f.percent(0.42)}</span>
          <span>{t('common.units.steps', { count: 3 })}</span>
        </Row>
        <Row label="Avatars">
          <Avatar name="Layla Haddad" size={24} />
          <Avatar name="Layla Haddad" size={32} />
          <Avatar name="ليلى حداد" size={40} />
        </Row>
        <Row label="Mono / LTR island">
          <span className="t-mono ltr">sha256:5d2f8c1a9e3b7d6f</span>
          <span className="ltr">layla.haddad@example.com</span>
        </Row>
      </Demo>

      <Demo title="Overlays">
        <Row>
          <Button onClick={() => setDialogOpen(true)}>Dialog</Button>
          <Button variant="danger" onClick={() => setDestructiveOpen(true)}>
            {t('common.actions.delete')}
          </Button>
          <Button onClick={() => setSheetOpen(true)}>Sheet</Button>
          <Button onClick={() => setApprovalOpen(true)}>{t('approvals.title.email')}</Button>
          <Button onClick={() => setVoiceOpen(true)}>{t('voice.title')}</Button>
          <Button onClick={() => setShortcutsOpen(true)}>{t('shell.shortcuts.title')}</Button>
        </Row>
        <Row label="Toasts">
          <Button size="sm" onClick={() => toast({ message: t('composer.sent') })}>
            Success
          </Button>
          <Button
            size="sm"
            onClick={() => toast({ tone: 'info', message: t('common.actions.copied') })}
          >
            Info
          </Button>
          <Button
            size="sm"
            onClick={() => toast({ tone: 'error', message: t('shell.account.signOutFailed') })}
          >
            Error
          </Button>
        </Row>
      </Demo>

      <Demo title="Command composer" wide>
        <CommandComposer
          shortcutTarget={false}
          onCreated={() => toast({ message: t('composer.sent') })}
        />
      </Demo>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={t('shell.shortcuts.title')}
        description={t('composer.placeholder')}
        footer={
          <>
            <Button onClick={() => setDialogOpen(false)}>{t('common.actions.cancel')}</Button>
            <Button variant="primary" onClick={() => setDialogOpen(false)}>
              {t('common.actions.done')}
            </Button>
          </>
        }
      >
        <p>{t('voice.privacy')}</p>
      </Dialog>
      <Dialog
        open={destructiveOpen}
        onClose={() => setDestructiveOpen(false)}
        title={t('common.actions.delete')}
        size="sm"
        footer={
          <>
            <Button onClick={() => setDestructiveOpen(false)}>{t('common.actions.cancel')}</Button>
            <Button variant="destructive" onClick={() => setDestructiveOpen(false)}>
              {t('common.actions.delete')}
            </Button>
          </>
        }
      >
        <p>{t('memory.disabled')}</p>
      </Dialog>
      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={t('notifications.title')}
        placement="side"
      >
        <p>{t('notifications.empty')}</p>
      </Sheet>
      <ApprovalSheet
        approval={approval}
        open={approvalOpen}
        onClose={() => setApprovalOpen(false)}
      />
      <VoiceMode
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        onCreated={() => toast({ message: t('composer.sent') })}
      />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
