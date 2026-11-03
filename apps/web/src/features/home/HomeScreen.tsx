'use client';

import type { Approval, AssistantStatus, HomeSnapshot, TaskSummary } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  BookmarkPlus,
  Cpu,
  FileText,
  Globe,
  Hand,
  ListChecks,
  Mail,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ApprovalSentence } from '@/components/approvals/ApprovalSentence';
import { ApprovalSheet } from '@/components/approvals/ApprovalSheet';
import { CommandComposer } from '@/components/composer/CommandComposer';
import { useComposerRegistry } from '@/components/composer/ComposerRegistry';
import { Presence } from '@/components/presence/Presence';
import { Page } from '@/components/shell/Page';
import { useShell } from '@/components/shell/ShellContext';
import { TaskRow } from '@/components/tasks/TaskRow';
import { ErrorBanner } from '@/components/ui/Banner';
import { RiskBadge, StatusPill } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, Section } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Skeleton, SkeletonRow } from '@/components/ui/Skeleton';
import { useI18n } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/catalog';
import { useHome, useMe } from '@/lib/api/hooks';
import { cx } from '@/lib/cx';
import { useNow } from '@/lib/hooks/useNow';
import { isUntrusted } from '@/features/tasks/model';
import styles from './HomeScreen.module.css';
import {
  dayPeriod,
  firstName,
  homeStatus,
  inProgressTasks,
  isFirstRun,
  knownSuggestions,
  safeInternalHref,
  type KnownSuggestion,
} from './model';

/** Items per Home section in the API (HOME_SECTION_LIMIT): a full section may have more. */
const SECTION_LIMIT = 5;

/**
 * Home — what needs me, what is happening, ask for something. A greeting with the live
 * Presence and status, the command composer, quiet suggestions, then only the sections that
 * have something in them (or one first-run state when nothing was ever asked).
 */
export function HomeScreen() {
  const { t } = useI18n();
  const home = useHome();
  const [reviewing, setReviewing] = useState<Approval | null>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const decidedTask = useRef<string | null>(null);

  // After a decision the Review button disappears once Home refreshes: move focus to the
  // task's row (now under In progress or Recent) or, failing that, the status line.
  useEffect(() => {
    const taskId = decidedTask.current;
    if (!taskId || !home.data) return;
    if (home.data.pendingApprovals.some((a) => a.taskId === taskId)) return;
    decidedTask.current = null;
    const row = document.querySelector<HTMLElement>(`#main a[href="/tasks/${taskId}"]`);
    (row ?? statusRef.current)?.focus();
  }, [home.data]);

  return (
    <Page
      title={<Greeting />}
      description={<StatusLine home={home.data} focusRef={statusRef} />}
      leading={<HomePresence />}
    >
      <div className={styles.ask}>
        <CommandComposer />
        {home.data && <SuggestionChips home={home.data} />}
      </div>

      {home.isPending && <HomeSkeleton />}
      {home.isError && !home.data && (
        <ErrorBanner
          title={t('home.loadError')}
          error={home.error}
          onRetry={() => void home.refetch()}
          retrying={home.isRefetching}
        />
      )}
      {home.data &&
        (isFirstRun(home.data) ? (
          <FirstRun assistant={home.data.assistant} />
        ) : (
          <div className={styles.sections}>
            <NeedsYou approvals={home.data.pendingApprovals} onReview={setReviewing} />
            <TaskSection
              title={t('home.sections.active')}
              tasks={inProgressTasks(home.data)}
              viewAll={
                home.data.activeTasks.length >= SECTION_LIMIT
                  ? { href: '/tasks?status=active', section: t('home.sections.active') }
                  : null
              }
            />
            <TaskSection
              title={t('home.sections.recent')}
              tasks={home.data.recentTasks}
              viewAll={{ href: '/tasks', section: t('home.sections.recent') }}
            />
          </div>
        ))}

      <ApprovalSheet
        approval={reviewing}
        open={reviewing !== null}
        onClose={() => setReviewing(null)}
        onDecided={(a) => {
          decidedTask.current = a.taskId;
        }}
      />
    </Page>
  );
}

/* ------------------------------------------------------------------ header */

function Greeting() {
  const { t } = useI18n();
  const me = useMe();
  const now = useNow();
  // Time-dependent text renders after hydration (now === 0 on the server) to avoid a mismatch.
  if (!me.data || now === 0) {
    return (
      <>
        <span className="visually-hidden">{t('home.title')}</span>
        <Skeleton width="min(20rem, 70vw)" height={28} className={styles.greetingSkeleton} />
      </>
    );
  }
  const period = dayPeriod(new Date(now), me.data.timeZone);
  const name = firstName(me.data.displayName);
  // The name is isolated inside the localized greeting, so the line follows the interface.
  return (
    <>{name ? t(`home.greeting.${period}`, { name }) : t(`home.greetingAnonymous.${period}`)}</>
  );
}

function HomePresence() {
  const { presence } = useShell();
  // Visual only: the status sentence beside it is the text, and the shell announces changes.
  return <Presence state={presence.state} progress={presence.progress} size={40} label="" />;
}

function StatusLine({
  home,
  focusRef,
}: {
  home: HomeSnapshot | undefined;
  focusRef: RefObject<HTMLSpanElement | null>;
}) {
  const { t, f } = useI18n();
  const me = useMe();
  const now = useNow();
  const { presence } = useShell();
  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(f.intlLocale, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone: me.data?.timeZone ?? f.timeZone,
      }),
    [f.intlLocale, f.timeZone, me.data?.timeZone],
  );
  if (now === 0 || !me.data) return <Skeleton width={240} height={18} />;

  // Without the overview (still loading or failed) only real connectivity states are shown —
  // never "Ready", which the screen could not know.
  const status = home
    ? homeStatus({
        presence: presence.state,
        pendingApprovals: home.pendingApprovals.length,
        activeTasks: home.activeTasks,
        plannerOffline: home.assistant.planner.mode === 'offline',
      })
    : presence.state === 'offline' ||
        presence.state === 'reconnecting' ||
        presence.state === 'listening'
      ? 'shell'
      : null;

  return (
    <span className={styles.statusLine} ref={focusRef} tabIndex={-1}>
      <time className={styles.date} dateTime={new Date(now).toISOString().slice(0, 10)}>
        {dateFmt.format(new Date(now))}
      </time>
      {status !== null && (
        <>
          <span className={styles.dot} aria-hidden="true">
            ·
          </span>
          <span className={styles.status}>
            {status === 'shell' ? (
              <span
                className={cx(
                  styles.statusPart,
                  presence.state === 'offline' && styles.statusWarning,
                )}
              >
                {t(presence.labelKey, presence.labelParams)}
              </span>
            ) : (
              status.map((part) => (
                <span
                  key={part.key}
                  className={cx(
                    styles.statusPart,
                    part.key === 'home.status.approvals' && styles.statusWarning,
                  )}
                >
                  {t(part.key, part.params)}
                </span>
              ))
            )}
          </span>
        </>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ suggestions */

const SUGGESTION_ICON: Record<KnownSuggestion['messageKey'], LucideIcon> = {
  'suggest.enableWeb': Globe,
  'suggest.connectEmail': Mail,
  'suggest.configureModel': Cpu,
  'suggest.summarizeAndEmail': FileText,
  'suggest.remember': BookmarkPlus,
};

const SUGGESTION_COMMAND: Partial<Record<KnownSuggestion['messageKey'], MessageKey>> = {
  'suggest.summarizeAndEmail': 'home.suggestCommands.summarizeAndEmail',
  'suggest.remember': 'home.suggestCommands.remember',
};

/**
 * Quiet chips from home.suggestions (derived by the API from real state). Command chips put an
 * example into the composer — never submit; connect / review chips open the right screen.
 */
function SuggestionChips({ home }: { home: HomeSnapshot }) {
  const { t, tDynamic } = useI18n();
  const registry = useComposerRegistry();
  const firstRun = isFirstRun(home);
  const offline = home.assistant.planner.mode === 'offline';
  const suggestions = knownSuggestions(home.suggestions).filter(
    (s) =>
      // The composer already explains the offline planner (with a link to its settings).
      s.messageKey !== 'suggest.configureModel' &&
      // The examples below (first run) or the composer's offline list (which names the same
      // commands) already cover the command suggestions.
      !((firstRun || offline) && s.kind === 'command'),
  );
  if (suggestions.length === 0) return null;
  return (
    <ul className={styles.chips} aria-label={t('home.suggestionsLabel')}>
      {suggestions.map((s) => {
        const label = tDynamic(`home.${s.messageKey}`, 'home.suggestionsLabel');
        const icon = SUGGESTION_ICON[s.messageKey];
        const commandKey = SUGGESTION_COMMAND[s.messageKey];
        const href = safeInternalHref(s.href);
        if (s.kind === 'command') {
          const command = s.command ?? (commandKey ? t(commandKey) : null);
          if (!command) return null;
          return (
            <li key={s.id}>
              <button
                type="button"
                className={styles.chip}
                onClick={() => registry?.fillComposer(command)}
                title={t('home.suggestionFills')}
              >
                <Icon icon={icon} size={16} className={styles.chipIcon} />
                <span>{label}</span>
              </button>
            </li>
          );
        }
        if (!href) return null;
        return (
          <li key={s.id}>
            <Link href={href} className={styles.chip}>
              <Icon icon={icon} size={16} className={styles.chipIcon} />
              <span>{label}</span>
              <Icon icon={ArrowRight} size={16} mirror className={styles.chipArrow} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ first run */

function FirstRun({ assistant }: { assistant: AssistantStatus }) {
  const { t } = useI18n();
  const registry = useComposerRegistry();
  const caps = assistant.capabilities;
  // Examples only for what this account can actually do right now.
  const examples = [
    caps.webFetch ? t('home.examples.summarize') : null,
    caps.memory ? t('home.examples.remember') : null,
    caps.email ? t('home.examples.emailMe') : null,
  ].filter((x): x is string => x !== null);
  const points: { icon: LucideIcon; text: string }[] = [
    { icon: ListChecks, text: t('home.firstRun.stepPlan') },
    { icon: Hand, text: t('home.firstRun.stepApprove') },
    { icon: ShieldCheck, text: t('home.firstRun.stepEvidence') },
  ];
  return (
    <Card className={styles.firstRun}>
      <div className={styles.firstRunHead}>
        <span className={styles.firstRunIcon} aria-hidden="true">
          <Icon icon={Sparkles} size={20} />
        </span>
        <div className={styles.firstRunText}>
          <h2 className={styles.firstRunTitle}>{t('home.firstRun.title')}</h2>
          <p className={styles.firstRunBody}>{t('home.firstRun.body')}</p>
        </div>
      </div>
      <ul className={styles.points}>
        {points.map((p) => (
          <li key={p.text}>
            <Icon icon={p.icon} size={16} className={styles.pointIcon} />
            {p.text}
          </li>
        ))}
      </ul>
      {examples.length > 0 && (
        <div className={styles.examples}>
          <p className={styles.examplesLabel} id="home-examples">
            {t('home.firstRun.tryLabel')}
          </p>
          <ul className={styles.exampleList} aria-labelledby="home-examples">
            {examples.map((text) => (
              <li key={text}>
                <button
                  type="button"
                  className={styles.example}
                  onClick={() => registry?.fillComposer(text)}
                  title={t('home.suggestionFills')}
                >
                  <bdi>{text}</bdi>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ sections */

function SectionTitle({ title, count }: { title: string; count: number }) {
  const { t } = useI18n();
  return (
    <span className={styles.sectionTitle}>
      {title}
      <span className={cx(styles.count, 'tabular')} aria-hidden="true">
        {count}
      </span>
      <span className="visually-hidden">, {t('home.sectionCount', { count })}</span>
    </span>
  );
}

/** "View all" with the section named for screen readers (visible text stays in the name). */
function ViewAll({ href, section }: { href: string; section: string }) {
  const { t } = useI18n();
  return (
    <Link href={href} className={styles.viewAll}>
      {t('home.viewAll')}
      <span className="visually-hidden">: {section}</span>
      <Icon icon={ArrowRight} size={16} mirror />
    </Link>
  );
}

function NeedsYou({
  approvals,
  onReview,
}: {
  approvals: readonly Approval[];
  onReview: (approval: Approval) => void;
}) {
  const { t } = useI18n();
  if (approvals.length === 0) return null;
  return (
    <Section
      title={<SectionTitle title={t('home.sections.approvals')} count={approvals.length} />}
      action={
        approvals.length >= SECTION_LIMIT ? (
          <ViewAll href="/tasks?status=needs_approval" section={t('home.sections.approvals')} />
        ) : undefined
      }
    >
      <Card padding="none" className={styles.needsCard}>
        <ul className={styles.approvals}>
          {approvals.map((a) => (
            <ApprovalRow key={a.id} approval={a} onReview={() => onReview(a)} />
          ))}
        </ul>
      </Card>
    </Section>
  );
}

function ApprovalRow({ approval, onReview }: { approval: Approval; onReview: () => void }) {
  const { t } = useI18n();
  const icon = approval.toolId === 'email.send' ? Mail : Hand;
  const untrusted = isUntrusted(approval);
  return (
    <li className={styles.approval}>
      <span className={styles.approvalIcon} aria-hidden="true">
        <Icon icon={icon} size={20} />
      </span>
      <div className={styles.approvalMain}>
        <p className={styles.approvalTitle}>
          <bdi>{approval.taskTitle}</bdi>
        </p>
        {/* In the interface language for email (the sheet says the same sentence). */}
        <ApprovalSentence approval={approval} className={styles.approvalSummary} />
        {untrusted && (
          <p className={styles.untrustedNote}>{t('approvals.untrusted.titleNoHost')}</p>
        )}
        <p className={styles.approvalMeta}>
          <RiskBadge level={approval.riskLevel} label={t(`common.risk.${approval.riskLevel}`)} />
          {untrusted && (
            <StatusPill tone="warning" icon={TriangleAlert} label={t('approvals.untrusted.chip')} />
          )}
          <RelativeTime
            value={approval.expiresAt}
            className={styles.expires}
            format={(time) => t('home.approval.expires', { time })}
          />
        </p>
      </div>
      <Button
        variant="primary"
        size="sm"
        className={styles.review}
        onClick={onReview}
        aria-label={t('home.approval.reviewLabel', { title: approval.taskTitle })}
      >
        {t('home.approval.review')}
      </Button>
    </li>
  );
}

function TaskSection({
  title,
  tasks,
  viewAll,
}: {
  title: string;
  tasks: readonly TaskSummary[];
  viewAll: { href: string; section: string } | null;
}) {
  if (tasks.length === 0) return null;
  return (
    <Section
      title={<SectionTitle title={title} count={tasks.length} />}
      action={viewAll ? <ViewAll href={viewAll.href} section={viewAll.section} /> : undefined}
    >
      <Card padding="none">
        <ul className={styles.taskList}>
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </ul>
      </Card>
    </Section>
  );
}

function HomeSkeleton() {
  const { t } = useI18n();
  return (
    <div className={styles.sections} aria-busy="true">
      <span className="visually-hidden" role="status">
        {t('home.loading')}
      </span>
      {[2, 2].map((rows, i) => (
        <div key={i} className={styles.skeletonSection}>
          <Skeleton width={120} height={18} />
          <Card padding="none">
            {Array.from({ length: rows }, (_, j) => (
              <SkeletonRow key={j} />
            ))}
          </Card>
        </div>
      ))}
    </div>
  );
}
