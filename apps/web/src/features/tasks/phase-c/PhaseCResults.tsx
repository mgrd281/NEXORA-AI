'use client';

import type {
  Booking,
  BrowserSession,
  EmailThreadSummary,
  EvidenceArtifact,
  Order,
  TaskDetail,
} from '@jarvis/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarCheck,
  CalendarPlus,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Download,
  ExternalLink,
  Hand,
  MailQuestion,
  PackageCheck,
  ShieldBan,
  Star,
  TimerOff,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { evidenceHref, EvidenceImage } from '@/components/evidence/EvidenceImage';
import { MoneyText, useTimeRange } from '@/components/approvals/PhaseCDetails';
import { Badge, StatusPill, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, Section } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { ErrorBanner } from '@/components/ui/Banner';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Skeleton } from '@/components/ui/Skeleton';
import { UserText } from '@/components/ui/UserText';
import type { MessageKey } from '@/i18n/catalog';
import { useI18n } from '@/i18n/I18nProvider';
import { lookup } from '@/i18n/translate';
import { PROVIDER_NAME } from '@/i18n/server-message';
import { api } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import { cx } from '@/lib/cx';
import { ExactTime, useByteFormat } from '../format';
import { safeExternalUrl } from '../model';
import {
  bookedView,
  calendarText,
  cartView,
  comparisonView,
  emailSearchView,
  knownSiteNames,
  orderedView,
  siteLabel,
  slotsView,
  succeeded,
  type ComparisonRow,
  type ComparisonView,
  type EmailSearchView,
  type SlotsView,
} from './results';
import { BROWSER_SESSIONS_ANCHOR } from './PhaseCEvidence';
import styles from './PhaseC.module.css';

/**
 * What the Phase C agents found or did, as the deliverable of the task page: email threads
 * (what needs a reply), mutual free times, a product comparison with its sources and the
 * screenshots behind it, a prepared cart, appointment slots (choose one to book it in a
 * follow-up), the confirmed booking with its ICS file, the placed order, and what the browser
 * agent saw on each site. Only real outputs are shown; a fact a page didn't state says so.
 */
export function PhaseCResults({
  task,
  onChooseSlot,
}: {
  task: TaskDetail;
  /** Puts a follow-up into the conversation's composer (the user still sends it). */
  onChooseSlot?: (text: string) => void;
}) {
  const steps = task.steps;
  const email = emailSearchView(succeeded(steps, 'email.search'));
  const freeBusy = calendarText(succeeded(steps, 'calendar.free_busy'));
  const comparison = comparisonView(steps);
  const cart = cartView(succeeded(steps, 'shop.prepare_cart'));
  const slots = slotsView(succeeded(steps, 'booking.find_slots'));
  const booked = bookedView(succeeded(steps, 'booking.book'));
  const ordered = orderedView(succeeded(steps, 'shop.checkout'));
  const names = knownSiteNames(task);
  // A finished booking or order is the result; its earlier search steps are only context.
  const showSlots = slots && !booked;
  const showComparison = comparison && comparison.rows.length > 0 && !ordered && !cart;
  return (
    <>
      {email && <EmailThreads view={email} />}
      {freeBusy && <TextResult title="tasks.phaseC.freeBusy.title" text={freeBusy} />}
      {showComparison && (
        <Comparison view={comparison} sessions={task.browserSessions ?? []} names={names} />
      )}
      {cart && !ordered && <Cart view={cart} sessions={task.browserSessions ?? []} />}
      {showSlots && (
        <Slots
          view={slots}
          siteName={slots.siteName ?? (slots.siteId ? siteLabel(slots.siteId, names) : null)}
          sessions={task.browserSessions ?? []}
          onChoose={onChooseSlot}
        />
      )}
      {booked && <BookingResult bookingId={booked.bookingId} />}
      {ordered && <OrderResult orderId={ordered.orderId} />}
      {task.browserSessions && task.browserSessions.length > 0 && (
        <BrowserSessions sessions={task.browserSessions} names={names} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ email */

function EmailThreads({ view }: { view: EmailSearchView }) {
  const { t } = useI18n();
  const title = view.needsReply
    ? t('tasks.phaseC.email.needsReplyTitle')
    : view.unreadOnly
      ? t('tasks.phaseC.email.unreadTitle')
      : t('tasks.phaseC.email.foundTitle');
  return (
    <Section
      title={title}
      description={
        view.provider === 'google' || view.provider === 'microsoft'
          ? t('tasks.phaseC.email.source', {
              provider: PROVIDER_NAME[view.provider],
              count: view.count,
            })
          : t('tasks.phaseC.email.count', { count: view.count })
      }
    >
      <Card padding="none">
        {view.count === 0 ? (
          <p className={styles.empty}>
            {view.needsReply ? t('tasks.phaseC.email.noneNeedReply') : t('tasks.phaseC.email.none')}
          </p>
        ) : view.threads ? (
          <ul className={styles.threads}>
            {view.threads.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} />
            ))}
          </ul>
        ) : (
          view.text && <ThreadLines text={view.text} />
        )}
        <p className={styles.untrustedNote}>
          <Icon icon={ShieldBan} size={16} />
          {t('tasks.phaseC.email.untrusted')}
        </p>
      </Card>
    </Section>
  );
}

function ThreadRow({ thread }: { thread: EmailThreadSummary }) {
  const { t } = useI18n();
  const link = safeExternalUrl(thread.webLink);
  const from = thread.lastMessageFrom;
  return (
    <li className={styles.thread}>
      <div className={styles.threadHead}>
        <UserText className={styles.threadFrom}>{from.name ?? from.address}</UserText>
        <RelativeTime value={thread.lastMessageAt} className={styles.threadTime} />
      </div>
      <p className={styles.threadSubject}>
        {link ? (
          <a href={link} target="_blank" rel="noopener noreferrer">
            <UserText>{thread.subject || t('approvals.fields.noSubject')}</UserText>
            <span className="visually-hidden"> {t('tasks.evidence.opensInNewTab')}</span>
          </a>
        ) : (
          <UserText>{thread.subject || t('approvals.fields.noSubject')}</UserText>
        )}
      </p>
      <p className={styles.threadSnippet} dir="auto">
        {thread.snippet}
      </p>
      <p className={styles.chips}>
        {thread.needsReply && (
          <Badge tone="accent" icon={MailQuestion}>
            {t('tasks.phaseC.email.needsReply')}
          </Badge>
        )}
        {thread.unread && <Badge>{t('tasks.phaseC.email.unread')}</Badge>}
        {thread.messageCount > 1 && (
          <span className={styles.meta}>
            {t('tasks.phaseC.email.messages', { count: thread.messageCount })}
          </span>
        )}
      </p>
    </li>
  );
}

/**
 * The tool's text list ("1. Name <address> — “Subject” (date): snippet"), one row per line.
 * Senders, subjects and snippets are other people's words: shown in their own direction.
 */
function ThreadLines({ text }: { text: string }) {
  const lines = text.split('\n');
  const items = lines.filter((l) => /^\d+\.\s/.test(l));
  if (items.length === 0) {
    return (
      <p className={styles.textBlock} dir="auto">
        {text}
      </p>
    );
  }
  return (
    <ol className={styles.threads}>
      {items.map((line, i) => {
        const m = /^\d+\.\s+(.*?)\s+—\s+“(.*)”\s+\((\d{4}-\d{2}-\d{2})\):\s*(.*)$/.exec(line);
        if (!m) {
          return (
            <li key={i} className={styles.thread} dir="auto">
              {line.replace(/^\d+\.\s+/, '')}
            </li>
          );
        }
        const [, from, subject, date, snippet] = m;
        return (
          <li key={i} className={styles.thread}>
            <div className={styles.threadHead}>
              <bdi className={styles.threadFrom}>{from!.replace(/\s*<[^>]+>$/, '')}</bdi>
              <time className={styles.threadTime} dateTime={date}>
                <ExactDate value={date!} />
              </time>
            </div>
            <p className={styles.threadSubject}>
              <bdi>{subject}</bdi>
            </p>
            {snippet && (
              <p className={styles.threadSnippet} dir="auto">
                {snippet}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ExactDate({ value }: { value: string }) {
  const { f } = useI18n();
  const date = new Date(`${value}T12:00:00Z`);
  return <>{Number.isNaN(date.getTime()) ? value : f.date(date)}</>;
}

function TextResult({ title, text }: { title: 'tasks.phaseC.freeBusy.title'; text: string }) {
  const { t } = useI18n();
  return (
    <Section title={t(title)}>
      <Card>
        <p className={styles.textBlock} dir="auto">
          {text}
        </p>
      </Card>
    </Section>
  );
}

/* ------------------------------------------------------------------ comparison */

function Comparison({
  view,
  sessions,
  names,
}: {
  view: ComparisonView;
  sessions: readonly BrowserSession[];
  names: ReadonlyMap<string, string>;
}) {
  const { t } = useI18n();
  // The shops' screenshots are the browser sessions' evidence: shown once, under "What JARVIS
  // saw on the sites" right after this section (not a second time here).
  const shots = sessions.some((s) => s.operation === 'search' && s.artifacts.length > 0);
  return (
    <Section
      title={t('tasks.phaseC.compare.title')}
      description={
        view.query
          ? t('tasks.phaseC.compare.description', { query: view.query, count: view.rows.length })
          : undefined
      }
    >
      <Card padding="none">
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('tasks.phaseC.compare.product')}</th>
                <th scope="col">{t('tasks.phaseC.compare.shop')}</th>
                <th scope="col" className={styles.num}>
                  {t('tasks.phaseC.compare.price')}
                </th>
                <th scope="col" className={styles.num}>
                  {t('tasks.phaseC.compare.shipping')}
                </th>
                <th scope="col" className={styles.num}>
                  {t('tasks.phaseC.compare.total')}
                </th>
                {view.detailed && <th scope="col">{t('tasks.phaseC.compare.delivery')}</th>}
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <OfferRow
                  key={row.key}
                  row={row}
                  best={row.key === view.bestKey}
                  detailed={view.detailed}
                />
              ))}
            </tbody>
          </table>
        </div>
        {/* Phones: the same offers as cards (the table needs more width than a phone has). */}
        <ul className={styles.offerCards}>
          {view.rows.map((row) => (
            <OfferCard
              key={row.key}
              row={row}
              best={row.key === view.bestKey}
              detailed={view.detailed}
            />
          ))}
        </ul>
        <div className={styles.sources}>
          {view.mixedCurrencies && (
            <p className={styles.note}>
              <Icon icon={CircleAlert} size={16} />
              {t('tasks.phaseC.compare.mixedCurrencies')}
            </p>
          )}
          <p className={styles.note}>{t('tasks.phaseC.compare.method')}</p>
          {view.sites.length > 0 && (
            <ul className={styles.siteList} aria-label={t('tasks.phaseC.compare.sitesLabel')}>
              {view.sites.map((site) => (
                <li key={site.siteId}>
                  <SiteStatus status={site.status} />
                  <span>{siteLabel(site.siteId, names)}</span>
                  {site.reason && (
                    <span className={styles.meta}>
                      {t(`tasks.phaseC.stopReasons.${site.reason}`)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {shots && (
            <p className={styles.note}>
              <a href={`#${BROWSER_SESSIONS_ANCHOR}`}>{t('tasks.phaseC.compare.evidenceLink')}</a>
            </p>
          )}
        </div>
      </Card>
    </Section>
  );
}

function OfferRow({
  row,
  best,
  detailed,
}: {
  row: ComparisonRow;
  best: boolean;
  detailed: boolean;
}) {
  const { t } = useI18n();
  return (
    <tr className={cx(best && styles.bestRow)}>
      <th scope="row" className={styles.productCell}>
        {row.productUrl ? (
          <a href={row.productUrl} target="_blank" rel="noopener noreferrer">
            <UserText>{row.title}</UserText>
            <span className="visually-hidden"> {t('tasks.evidence.opensInNewTab')}</span>
          </a>
        ) : (
          <UserText>{row.title}</UserText>
        )}
        <span className={styles.cellChips}>
          {best && (
            <Badge tone="success" icon={CircleCheck}>
              {t('tasks.phaseC.compare.best')}
            </Badge>
          )}
          {row.inStock === false && (
            <Badge tone="warning">{t('tasks.phaseC.compare.outOfStock')}</Badge>
          )}
          {row.rating && (
            <span className={styles.rating}>
              <Icon icon={Star} size={16} />
              <span className="tabular">
                {t('tasks.phaseC.compare.rating', {
                  value: row.rating.value.toFixed(1),
                  count: row.rating.count,
                })}
              </span>
            </span>
          )}
        </span>
      </th>
      <td>
        <UserText>{row.merchant}</UserText>
        {row.signals.length > 0 && (
          <ul className={styles.signals}>
            {row.signals
              .filter((s) => s.code !== 'customer_rating')
              .map((s) => (
                <li key={s.code} className={cx(!s.present && styles.signalMissing)}>
                  <Icon icon={s.present ? CircleCheck : CircleDashed} size={16} />
                  {t(`tasks.phaseC.signals.${s.code}`)}
                  <span className="visually-hidden">
                    {' '}
                    {s.present
                      ? t('tasks.phaseC.signals.present')
                      : t('tasks.phaseC.signals.absent')}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </td>
      <td className={styles.num}>{row.price ? <MoneyText value={row.price} /> : <NotStated />}</td>
      <td className={styles.num}>
        {row.shipping ? (
          <MoneyText value={row.shipping} />
        ) : row.shipping === null ? (
          <NotStated />
        ) : (
          <span className={styles.meta}>—</span>
        )}
      </td>
      <td className={cx(styles.num, styles.totalCell)}>
        {row.total ? <MoneyText value={row.total} /> : <NotStated />}
      </td>
      {detailed && (
        <td>
          {row.delivery?.text ? (
            <UserText>{row.delivery.text}</UserText>
          ) : row.delivery?.minDays != null ? (
            t('tasks.phaseC.compare.days', {
              min: row.delivery.minDays,
              max: row.delivery.maxDays ?? row.delivery.minDays,
            })
          ) : (
            <NotStated />
          )}
        </td>
      )}
    </tr>
  );
}

function OfferCard({
  row,
  best,
  detailed,
}: {
  row: ComparisonRow;
  best: boolean;
  detailed: boolean;
}) {
  const { t } = useI18n();
  return (
    <li className={cx(styles.offerCard, best && styles.bestRow)}>
      <p className={styles.offerTitle}>
        <UserText>{row.title}</UserText>
      </p>
      <p className={styles.meta}>
        <UserText>{row.merchant}</UserText>
      </p>
      {(best || row.inStock === false) && (
        <p className={styles.cellChips}>
          {best && (
            <Badge tone="success" icon={CircleCheck}>
              {t('tasks.phaseC.compare.best')}
            </Badge>
          )}
          {row.inStock === false && (
            <Badge tone="warning">{t('tasks.phaseC.compare.outOfStock')}</Badge>
          )}
        </p>
      )}
      <dl className={styles.offerFacts}>
        <div>
          <dt>{t('tasks.phaseC.compare.price')}</dt>
          <dd>{row.price ? <MoneyText value={row.price} /> : <NotStated />}</dd>
        </div>
        <div>
          <dt>{t('tasks.phaseC.compare.shipping')}</dt>
          <dd>
            {row.shipping ? (
              <MoneyText value={row.shipping} />
            ) : row.shipping === null ? (
              <NotStated />
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div className={styles.totalCell}>
          <dt>{t('tasks.phaseC.compare.total')}</dt>
          <dd>{row.total ? <MoneyText value={row.total} /> : <NotStated />}</dd>
        </div>
        {detailed && (
          <div>
            <dt>{t('tasks.phaseC.compare.delivery')}</dt>
            <dd>
              {row.delivery?.text ? (
                <UserText>{row.delivery.text}</UserText>
              ) : row.delivery?.minDays != null ? (
                t('tasks.phaseC.compare.days', {
                  min: row.delivery.minDays,
                  max: row.delivery.maxDays ?? row.delivery.minDays,
                })
              ) : (
                <NotStated />
              )}
            </dd>
          </div>
        )}
      </dl>
    </li>
  );
}

function NotStated() {
  const { t } = useI18n();
  return <span className={styles.meta}>{t('tasks.phaseC.notStated')}</span>;
}

const SITE_STATUS: Record<'ok' | 'failed' | 'handover', { tone: Tone; icon: LucideIcon }> = {
  ok: { tone: 'success', icon: CircleCheck },
  failed: { tone: 'danger', icon: CircleAlert },
  handover: { tone: 'warning', icon: Hand },
};

function SiteStatus({ status }: { status: 'ok' | 'failed' | 'handover' }) {
  const { t } = useI18n();
  const s = SITE_STATUS[status];
  return <StatusPill tone={s.tone} icon={s.icon} label={t(`tasks.phaseC.siteStatus.${status}`)} />;
}

/* ------------------------------------------------------------------ cart */

function Cart({
  view,
  sessions,
}: {
  view: NonNullable<ReturnType<typeof cartView>>;
  sessions: readonly BrowserSession[];
}) {
  const { t } = useI18n();
  const shot = sessions
    .filter((s) => s.operation === 'cart')
    .flatMap((s) => s.artifacts)
    .find((a) => a.kind === 'screenshot');
  return (
    <Section title={t('tasks.phaseC.cart.title')} description={t('tasks.phaseC.cart.description')}>
      <Card padding="none">
        <ul className={styles.lines}>
          {view.lines.map((line, i) => (
            <li key={i}>
              <span className={styles.lineTitle}>
                <UserText>{line.title}</UserText>
                <span className={styles.meta}>
                  {t('tasks.phaseC.cart.quantity', { count: line.quantity })}
                </span>
              </span>
              {line.lineTotal && <MoneyText value={line.lineTotal} />}
            </li>
          ))}
        </ul>
        <div className={styles.cartTotal}>
          <span>
            {view.merchant
              ? t('tasks.phaseC.cart.totalAt', { merchant: view.merchant })
              : t('tasks.phaseC.cart.total')}
          </span>
          {view.total ? <MoneyText value={view.total} className={styles.strong} /> : <NotStated />}
        </div>
        {view.checkoutSupported === false && view.handoverUrl && (
          <div className={styles.handover}>
            <p>{t('tasks.phaseC.cart.handover', { merchant: view.merchant ?? '' })}</p>
            <a
              href={view.handoverUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.externalButton}
            >
              {t('tasks.phaseC.cart.openCart')}
              <Icon icon={ExternalLink} size={16} />
            </a>
          </div>
        )}
        {shot && (
          <div className={styles.shots}>
            <EvidenceImage artifact={shot} caption={t('tasks.phaseC.cart.evidence')} size="sm" />
          </div>
        )}
      </Card>
    </Section>
  );
}

/* ------------------------------------------------------------------ slots */

function Slots({
  view,
  siteName,
  sessions,
  onChoose,
}: {
  view: SlotsView;
  siteName: string | null;
  sessions: readonly BrowserSession[];
  onChoose?: (text: string) => void;
}) {
  const { t, f } = useI18n();
  const range = useTimeRange();
  const shot =
    sessions
      .filter((s) => s.operation === 'slots')
      .flatMap((s) => s.artifacts)
      .find(
        (a) =>
          a.kind === 'screenshot' && (!view.evidenceArtifactId || a.id === view.evidenceArtifactId),
      ) ?? (view.evidenceArtifactId ? { id: view.evidenceArtifactId } : null);
  const zone = view.slots[0]?.timeZone ?? null;
  const command = (start: string, timeZone: string) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(start));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return t('tasks.phaseC.slots.command', {
      service: view.service ?? '',
      site: siteName ?? '',
      date: `${get('year')}-${get('month')}-${get('day')}`,
      time: `${get('hour')}:${get('minute')}`,
    });
  };
  return (
    <Section
      title={t('tasks.phaseC.slots.title')}
      description={
        siteName
          ? t('tasks.phaseC.slots.description', {
              site: siteName,
              service: view.service ?? '',
              count: view.total,
            })
          : undefined
      }
    >
      <Card padding="none">
        {view.slots.length === 0 ? (
          <p className={styles.empty}>{t('tasks.phaseC.slots.none')}</p>
        ) : (
          <ul className={styles.slots}>
            {view.slots.map((slot) => (
              <li key={slot.start} className={styles.slot}>
                <span className={styles.slotTime}>
                  <span className={cx(styles.strong, 'tabular')}>
                    {range(slot.start, slot.end, slot.timeZone)}
                  </span>
                  {slot.price && <MoneyText value={slot.price} className={styles.meta} />}
                </span>
                {onChoose && view.service && siteName && (
                  <Button
                    size="sm"
                    onClick={() => onChoose(command(slot.start, slot.timeZone))}
                    aria-label={t('tasks.phaseC.slots.chooseLabel', {
                      time: range(slot.start, slot.end, slot.timeZone),
                    })}
                  >
                    {t('tasks.phaseC.slots.choose')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className={styles.sources}>
          {zone && (
            <p className={styles.note}>
              {t('tasks.phaseC.slots.zone', { zone })}
              {view.total > view.slots.length &&
                ` ${t('tasks.phaseC.slots.more', { count: view.total - view.slots.length })}`}
            </p>
          )}
          {view.requiredFields.length > 0 && (
            <p className={styles.note}>
              {t('tasks.phaseC.slots.needs', { fields: f.list(view.requiredFields) })}
            </p>
          )}
          {onChoose && <p className={styles.note}>{t('tasks.phaseC.slots.howToBook')}</p>}
        </div>
        {shot && (
          <div className={styles.shots}>
            <EvidenceImage
              artifact={shot}
              caption={t('tasks.phaseC.slots.evidence', { site: siteName ?? '' })}
              size="sm"
            />
          </div>
        )}
      </Card>
    </Section>
  );
}

/* ------------------------------------------------------------------ booking, order */

const BOOKING_STATUS: Record<Booking['status'], { tone: Tone; icon: LucideIcon }> = {
  submitting: { tone: 'accent', icon: CircleDashed },
  confirmed: { tone: 'success', icon: CalendarCheck },
  failed: { tone: 'danger', icon: CircleAlert },
  unknown: { tone: 'warning', icon: TimerOff },
  cancelled: { tone: 'neutral', icon: CircleDashed },
};

export function BookingStatusPill({ status }: { status: Booking['status'] }) {
  const { t } = useI18n();
  const s = BOOKING_STATUS[status];
  return (
    <StatusPill tone={s.tone} icon={s.icon} label={t(`tasks.phaseC.bookingStatus.${status}`)} />
  );
}

const ORDER_STATUS: Record<Order['status'], { tone: Tone; icon: LucideIcon }> = {
  submitting: { tone: 'accent', icon: CircleDashed },
  placed: { tone: 'success', icon: PackageCheck },
  failed: { tone: 'danger', icon: CircleAlert },
  unknown: { tone: 'warning', icon: TimerOff },
};

export function OrderStatusPill({ status }: { status: Order['status'] }) {
  const { t } = useI18n();
  const s = ORDER_STATUS[status];
  return <StatusPill tone={s.tone} icon={s.icon} label={t(`tasks.phaseC.orderStatus.${status}`)} />;
}

function BookingResult({ bookingId }: { bookingId: string }) {
  const { t } = useI18n();
  const range = useTimeRange();
  const booking = useQuery({
    queryKey: qk.bookings.detail(bookingId),
    queryFn: ({ signal }) => api.call('getBooking', { params: { id: bookingId }, signal }),
  });
  return (
    <Section title={t('tasks.phaseC.booking.title')}>
      <Card padding="none">
        {booking.isPending ? (
          <div className={styles.loading} aria-busy="true">
            <Skeleton width="40%" height={20} />
            <Skeleton width="70%" height={14} />
          </div>
        ) : booking.isError ? (
          <div className={styles.loading}>
            <ErrorBanner error={booking.error} onRetry={() => void booking.refetch()} />
          </div>
        ) : (
          <BookingCard booking={booking.data} range={range} />
        )}
      </Card>
    </Section>
  );
}

function BookingCard({
  booking,
  range,
}: {
  booking: Booking;
  range: ReturnType<typeof useTimeRange>;
}) {
  const { t } = useI18n();
  const ics = booking.evidence.find((a) => a.kind === 'ics');
  const shot = booking.evidence.find((a) => a.kind === 'screenshot');
  return (
    <>
      <div className={styles.recordHead}>
        <span className={styles.recordIcon} aria-hidden="true">
          <Icon icon={CalendarCheck} size={20} />
        </span>
        <div className={styles.recordTitles}>
          <p className={styles.recordTitle}>
            <UserText>{booking.service}</UserText> · <UserText>{booking.siteName}</UserText>
          </p>
          <p className={cx(styles.meta, 'tabular')}>
            {range(booking.start, booking.end, booking.timeZone)} · {booking.timeZone}
          </p>
        </div>
        <BookingStatusPill status={booking.status} />
      </div>
      <dl className={styles.recordFacts}>
        {booking.reference && (
          <div>
            <dt>{t('tasks.phaseC.booking.reference')}</dt>
            <dd className={styles.idValue}>
              <code className="ltr">{booking.reference}</code>
              <CopyButton value={booking.reference} label={t('tasks.phaseC.booking.reference')} />
            </dd>
          </div>
        )}
        <div>
          <dt>{t('tasks.phaseC.booking.price')}</dt>
          <dd>
            {booking.price ? <MoneyText value={booking.price} /> : t('tasks.phaseC.booking.free')}
          </dd>
        </div>
        <div>
          <dt>{t('tasks.phaseC.booking.calendar')}</dt>
          <dd>
            {booking.calendarEventId ? (
              <span className={styles.inline}>
                <Icon icon={CalendarPlus} size={16} />
                {t('tasks.phaseC.booking.inCalendar')}
              </span>
            ) : (
              t('tasks.phaseC.booking.notInCalendar')
            )}
          </dd>
        </div>
      </dl>
      {(ics || shot) && (
        <div className={styles.shots}>
          {ics && <FileLink artifact={ics} label={t('tasks.phaseC.booking.ics')} />}
          {shot && (
            <EvidenceImage artifact={shot} caption={t('tasks.phaseC.booking.evidence')} size="sm" />
          )}
        </div>
      )}
    </>
  );
}

function OrderResult({ orderId }: { orderId: string }) {
  const { t } = useI18n();
  const order = useQuery({
    queryKey: qk.orders.detail(orderId),
    queryFn: ({ signal }) => api.call('getOrder', { params: { id: orderId }, signal }),
  });
  return (
    <Section title={t('tasks.phaseC.order.title')}>
      <Card padding="none">
        {order.isPending ? (
          <div className={styles.loading} aria-busy="true">
            <Skeleton width="40%" height={20} />
            <Skeleton width="70%" height={14} />
          </div>
        ) : order.isError ? (
          <div className={styles.loading}>
            <ErrorBanner error={order.error} onRetry={() => void order.refetch()} />
          </div>
        ) : (
          <OrderCard order={order.data} />
        )}
      </Card>
    </Section>
  );
}

export function OrderCard({ order }: { order: Order }) {
  const { t } = useI18n();
  const failureLine = useFailureLine();
  const shot = order.evidence.find((a) => a.kind === 'screenshot');
  return (
    <>
      <div className={styles.recordHead}>
        <span className={styles.recordIcon} aria-hidden="true">
          <Icon icon={PackageCheck} size={20} />
        </span>
        <div className={styles.recordTitles}>
          <p className={styles.recordTitle}>
            <UserText>{order.merchantName}</UserText>
          </p>
          <p className={styles.meta}>
            {order.placedAt ? (
              <ExactTime value={order.placedAt} />
            ) : (
              <ExactTime value={order.createdAt} />
            )}
          </p>
        </div>
        <OrderStatusPill status={order.status} />
      </div>
      <ul className={styles.lines}>
        {order.items.map((item, i) => (
          <li key={i}>
            <span className={styles.lineTitle}>
              <UserText>{item.title}</UserText>
              <span className={styles.meta}>
                {t('tasks.phaseC.cart.quantity', { count: item.quantity })} ·{' '}
                <MoneyText value={item.unitPrice} />
              </span>
            </span>
            <MoneyText value={item.lineTotal} />
          </li>
        ))}
      </ul>
      <dl className={styles.orderTotals}>
        <div>
          <dt>{t('approvals.purchase.shipping')}</dt>
          <dd>
            <MoneyText value={order.shipping} />
          </dd>
        </div>
        <div className={styles.strong}>
          <dt>{t('approvals.purchase.total')}</dt>
          <dd>
            <MoneyText value={order.total} />
          </dd>
        </div>
      </dl>
      <dl className={styles.recordFacts}>
        {order.merchantOrderId && (
          <div>
            <dt>{t('tasks.phaseC.order.number')}</dt>
            <dd className={styles.idValue}>
              <code className="ltr">{order.merchantOrderId}</code>
              <CopyButton value={order.merchantOrderId} label={t('tasks.phaseC.order.number')} />
            </dd>
          </div>
        )}
        {order.failureReason && (
          <div>
            <dt>{t('tasks.phaseC.order.why')}</dt>
            <dd>{failureLine(order.failureReason)}</dd>
          </div>
        )}
      </dl>
      {shot && (
        <div className={styles.shots}>
          <EvidenceImage artifact={shot} caption={t('tasks.phaseC.order.evidence')} size="sm" />
        </div>
      )}
    </>
  );
}

/**
 * Why an order or booking failed, from its reason alone (the row carries no parameters): a
 * short sentence of its own, or the task error sentence when it needs none.
 */
export function useFailureLine() {
  const { t, messages } = useI18n();
  return (reason: string): string => {
    const own = `tasks.phaseC.failure.${reason}`;
    if (lookup(messages, own) !== undefined) return t(own as MessageKey);
    const sentence = lookup(messages, `errors.reasons.${reason}`);
    if (sentence !== undefined && !sentence.includes('{'))
      return t(`errors.reasons.${reason}` as MessageKey);
    return t('tasks.phaseC.failure.generic');
  };
}

/** A non-image evidence file (ICS, extracted data) as a download. */
export function FileLink({ artifact, label }: { artifact: EvidenceArtifact; label: string }) {
  const bytes = useByteFormat();
  return (
    <a href={evidenceHref(artifact)} download className={styles.fileLink}>
      <Icon icon={Download} size={16} />
      <span>{label}</span>
      <bdi className={cx(styles.meta, 'tabular')}>{bytes(artifact.sizeBytes)}</bdi>
    </a>
  );
}

/* ------------------------------------------------------------------ browser sessions */

const SESSION_STATUS: Record<BrowserSession['status'], { tone: Tone; icon: LucideIcon }> = {
  queued: { tone: 'neutral', icon: CircleDashed },
  running: { tone: 'accent', icon: CircleDashed },
  succeeded: { tone: 'success', icon: CircleCheck },
  failed: { tone: 'danger', icon: CircleAlert },
  handover: { tone: 'warning', icon: Hand },
  interrupted: { tone: 'warning', icon: TimerOff },
};

function BrowserSessions({
  sessions,
  names,
}: {
  sessions: readonly BrowserSession[];
  names: ReadonlyMap<string, string>;
}) {
  const { t } = useI18n();
  return (
    <Section
      id={BROWSER_SESSIONS_ANCHOR}
      title={t('tasks.phaseC.sessions.title')}
      description={t('tasks.phaseC.sessions.description')}
    >
      <Card padding="none">
        <ol className={styles.sessions}>
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} name={siteLabel(s.siteId, names)} />
          ))}
        </ol>
      </Card>
    </Section>
  );
}

function SessionRow({ session, name }: { session: BrowserSession; name: string }) {
  const { t } = useI18n();
  const status = SESSION_STATUS[session.status];
  const handover = safeExternalUrl(session.handoverUrl);
  const files = session.artifacts.filter((a) => a.kind !== 'screenshot');
  const shots = session.artifacts.filter((a) => a.kind === 'screenshot');
  return (
    <li className={styles.session}>
      <div className={styles.sessionHead}>
        <div className={styles.recordTitles}>
          <p className={styles.recordTitle}>
            {name}
            <span className={styles.meta}>
              {' · '}
              {t(`tasks.phaseC.operations.${operationKey(session.operation)}`)}
            </span>
          </p>
          <p className={styles.meta}>
            {t('tasks.phaseC.sessions.counts', {
              navigations: session.navigations,
              requests: session.requests,
            })}
            {session.blockedRequests > 0 && (
              <> · {t('tasks.phaseC.sessions.blocked', { count: session.blockedRequests })}</>
            )}
            {session.endedAt && (
              <>
                {' · '}
                <ExactTime value={session.endedAt} timeOnly />
              </>
            )}
          </p>
        </div>
        <StatusPill
          tone={status.tone}
          icon={status.icon}
          label={t(`tasks.phaseC.sessionStatus.${session.status}`)}
        />
      </div>
      {session.stopReason && session.stopReason !== 'CANCELLED' && (
        <p className={styles.stop}>{t(`tasks.phaseC.stopReasons.${session.stopReason}`)}</p>
      )}
      {session.status === 'handover' && handover && (
        <div className={styles.handover}>
          <p>{t('tasks.phaseC.sessions.handover')}</p>
          <a
            href={handover}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.externalButton}
          >
            {t('tasks.phaseC.openSite')}
            <Icon icon={ExternalLink} size={16} />
            <span className="visually-hidden"> {t('tasks.evidence.opensInNewTab')}</span>
          </a>
        </div>
      )}
      {(shots.length > 0 || files.length > 0) && (
        <div className={styles.sessionFiles}>
          {shots.map((a) => (
            <EvidenceImage
              key={a.id}
              artifact={a}
              caption={t('tasks.phaseC.sessions.shot', { site: name })}
              size="sm"
            />
          ))}
          {files.map((a) => (
            <FileLink
              key={a.id}
              artifact={a}
              label={
                a.kind === 'ics'
                  ? t('tasks.phaseC.booking.ics')
                  : t('tasks.phaseC.sessions.extract')
              }
            />
          ))}
        </div>
      )}
    </li>
  );
}

const OPERATIONS = [
  'search',
  'product',
  'cart',
  'checkout',
  'slots',
  'book',
  'read',
  'fill',
] as const;
function operationKey(op: string): (typeof OPERATIONS)[number] | 'other' {
  return (OPERATIONS as readonly string[]).includes(op)
    ? (op as (typeof OPERATIONS)[number])
    : 'other';
}
