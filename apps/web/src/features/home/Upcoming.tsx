'use client';

import type { CalendarEventSummary, CalendarSource, UpcomingEvents } from '@jarvis/contracts';
import { CalendarOff, CircleDot, ExternalLink, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Banner } from '@/components/ui/Banner';
import { Card, Section } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { UserText } from '@/components/ui/UserText';
import { useI18n } from '@/i18n/I18nProvider';
import { PROVIDER_NAME } from '@/i18n/server-message';
import { stripIsolates } from '@/i18n/translate';
import { useMe } from '@/lib/api/hooks';
import { cx } from '@/lib/cx';
import { useNow } from '@/lib/hooks/useNow';
import { ReconnectButton } from '@/features/connections/Reconnect';
import { safeExternalUrl } from '@/features/tasks/model';
import styles from './Upcoming.module.css';
import {
  conflicts,
  eventKey,
  isNow,
  otherZone,
  problemSources,
  upcomingDays,
  type UpcomingDay,
} from './upcoming';

/**
 * Home "Upcoming" (spec §4A): the next events of the connected calendars, read live from the
 * providers. Rendered only when a calendar is connected (HomeSnapshot.upcoming is not null) —
 * never an empty widget. Times are in the account's zone (a second time in the event's own zone
 * when it differs), overlapping events are flagged, and a calendar that couldn't answer says so
 * with its fix (Reconnect, Allow) instead of silently missing events.
 */
export function Upcoming({ upcoming }: { upcoming: UpcomingEvents }) {
  const { t } = useI18n();
  const me = useMe();
  const now = useNow();
  const zone = me.data?.timeZone;
  const reference = now === 0 ? Date.parse(upcoming.fetchedAt) : now;
  const days = useMemo(
    () => upcomingDays(upcoming.events, zone, reference),
    [upcoming.events, zone, reference],
  );
  const overlaps = useMemo(() => conflicts(upcoming.events), [upcoming.events]);
  const problems = problemSources(upcoming);
  const count = upcoming.events.length;

  return (
    <Section
      title={
        <span className={styles.heading}>
          <span aria-hidden="true">{t('home.upcoming.title')}</span>
          {count > 0 && (
            <span className={cx(styles.count, 'tabular')} aria-hidden="true">
              {count}
            </span>
          )}
          <span className="visually-hidden">
            {stripIsolates(t('home.sectionHeading', { title: t('home.upcoming.title'), count }))}
          </span>
        </span>
      }
    >
      <div className={styles.stack}>
        {problems.map((source) => (
          <SourceProblem key={source.connectionId} source={source} />
        ))}
        {/* "Nothing in your calendar" only when a calendar actually answered: with every
            source expired or unavailable, the banners above are the whole truth. */}
        {(days.length > 0 || upcoming.sources.some((s) => s.status === 'ok')) && (
          <Card padding="none">
            {days.length === 0 ? (
              <p className={styles.empty}>
                <Icon icon={CalendarOff} size={20} className={styles.emptyIcon} />
                {t('home.upcoming.empty')}
              </p>
            ) : (
              <ol className={styles.days}>
                {days.map((day) => (
                  <Day key={day.key} day={day} zone={zone} now={reference} overlaps={overlaps} />
                ))}
              </ol>
            )}
          </Card>
        )}
      </div>
    </Section>
  );
}

function Day({
  day,
  zone,
  now,
  overlaps,
}: {
  day: UpcomingDay;
  zone: string | undefined;
  now: number;
  overlaps: Map<string, CalendarEventSummary[]>;
}) {
  const { t, f } = useI18n();
  const date = new Intl.DateTimeFormat(f.intlLocale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: zone,
  }).format(new Date(day.anchor));
  const headingId = `upcoming-${day.key}`;
  return (
    <li className={styles.day} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.dayTitle}>
        {day.relative !== null && (
          <span className={styles.dayRelative}>
            {day.relative === 0 ? t('home.upcoming.today') : t('home.upcoming.tomorrow')}
          </span>
        )}
        <span className={day.relative !== null ? styles.dayDate : styles.dayRelative}>{date}</span>
      </h3>
      <ul className={styles.events}>
        {day.events.map((e) => (
          <EventRow
            key={eventKey(e)}
            event={e}
            zone={zone}
            now={now}
            overlapsWith={overlaps.get(eventKey(e)) ?? []}
          />
        ))}
      </ul>
    </li>
  );
}

function EventRow({
  event,
  zone,
  now,
  overlapsWith,
}: {
  event: CalendarEventSummary;
  zone: string | undefined;
  now: number;
  overlapsWith: readonly CalendarEventSummary[];
}) {
  const { t, f } = useI18n();
  const time = (iso: string, timeZone: string | undefined) =>
    new Intl.DateTimeFormat(f.intlLocale, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }).format(new Date(iso));
  const second = otherZone(event, zone);
  const link = safeExternalUrl(event.webLink);
  const cancelled = event.status === 'cancelled';
  const happening = isNow(event, now);
  const meta = [
    event.location,
    event.attendeeCount > 0 ? t('home.upcoming.people', { count: event.attendeeCount }) : null,
  ].filter((x): x is string => Boolean(x));
  const title = (
    <UserText className={cx(styles.title, cancelled && styles.cancelled)}>{event.title}</UserText>
  );
  return (
    <li className={styles.event}>
      <div className={styles.when}>
        {event.allDay ? (
          <span className={styles.time}>{t('home.upcoming.allDay')}</span>
        ) : (
          <>
            <time className={cx(styles.time, 'tabular')} dateTime={event.start}>
              {time(event.start, zone)}
            </time>
            <time className={cx(styles.end, 'tabular')} dateTime={event.end}>
              {time(event.end, zone)}
            </time>
          </>
        )}
      </div>
      <div className={styles.main}>
        <p className={styles.titleRow}>
          {link ? (
            <a href={link} target="_blank" rel="noopener noreferrer" className={styles.titleLink}>
              {title}
              <Icon icon={ExternalLink} size={16} className={styles.linkIcon} />
              <span className="visually-hidden">
                {' '}
                {t('home.upcoming.openAt', { provider: PROVIDER_NAME[event.provider] })}
              </span>
            </a>
          ) : (
            title
          )}
        </p>
        {(meta.length > 0 || second) && (
          <p className={styles.meta}>
            {meta.map((m, i) => (
              <span key={i}>
                {i > 0 && <span aria-hidden="true"> · </span>}
                {i === 0 && event.location ? <bdi>{m}</bdi> : m}
              </span>
            ))}
            {second && (
              <span>
                {meta.length > 0 && <span aria-hidden="true"> · </span>}
                {t('home.upcoming.inZone', {
                  time: `${time(event.start, second)}`,
                  zone: zoneName(second, f.intlLocale, event.start),
                })}
              </span>
            )}
          </p>
        )}
        {(happening || cancelled || event.status === 'tentative' || overlapsWith.length > 0) && (
          <p className={styles.chips}>
            {happening && (
              <Badge tone="accent" icon={CircleDot}>
                {t('home.upcoming.now')}
              </Badge>
            )}
            {cancelled && <Badge>{t('home.upcoming.cancelled')}</Badge>}
            {event.status === 'tentative' && <Badge>{t('home.upcoming.tentative')}</Badge>}
            {overlapsWith.length > 0 && (
              <Badge tone="warning" icon={TriangleAlert}>
                {overlapsWith.length === 1
                  ? t('home.upcoming.overlapsWith', { title: overlapsWith[0]!.title })
                  : t('home.upcoming.overlapsMany', { count: overlapsWith.length })}
              </Badge>
            )}
          </p>
        )}
      </div>
    </li>
  );
}

/** "Eastern Time" / "Nordamerikanische Ostküstenzeit" for a zone, else its city. */
function zoneName(zone: string, intlLocale: string, at: string): string {
  try {
    const name = new Intl.DateTimeFormat(intlLocale, {
      timeZone: zone,
      timeZoneName: 'longGeneric',
    })
      .formatToParts(new Date(at))
      .find((p) => p.type === 'timeZoneName')?.value;
    if (name && !/^GMT/.test(name)) return name;
  } catch {
    // fall through
  }
  return (zone.split('/').pop() ?? zone).replaceAll('_', ' ');
}

/** A calendar that did not answer: what is missing and what fixes it. */
function SourceProblem({ source }: { source: CalendarSource }) {
  const { t } = useI18n();
  const provider = PROVIDER_NAME[source.provider];
  const account = source.accountIdentifier ?? provider;
  switch (source.status) {
    case 'expired':
      return (
        <Banner
          tone="warning"
          title={t('home.upcoming.sources.expired', { provider, account })}
          action={
            <ReconnectButton
              provider={source.provider}
              connectionId={source.connectionId}
              returnTo="/"
              size="sm"
            />
          }
        />
      );
    case 'scope_missing':
      return (
        <Banner
          tone="warning"
          title={t('home.upcoming.sources.scope_missing', { provider, account })}
          action={
            <ReconnectButton
              provider={source.provider}
              connectionId={source.connectionId}
              capability="calendar.read"
              returnTo="/"
              size="sm"
            />
          }
        />
      );
    case 'unavailable':
      return (
        <Banner tone="info" title={t('home.upcoming.sources.unavailable', { provider, account })} />
      );
    case 'ok':
      return null;
  }
}
