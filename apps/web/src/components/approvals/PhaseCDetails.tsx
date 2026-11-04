'use client';

import type { ApprovalDetails, Money } from '@jarvis/contracts';
import { CalendarClock, CircleAlert, Lock, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { EvidenceImage } from '@/components/evidence/EvidenceImage';
import { Badge } from '@/components/ui/Badge';
import { Icon } from '@/components/ui/Icon';
import { UserText } from '@/components/ui/UserText';
import { useI18n } from '@/i18n/I18nProvider';
import { PROVIDER_NAME } from '@/i18n/server-message';
import { stripIsolates } from '@/i18n/translate';
import { useMe } from '@/lib/api/hooks';
import { cx } from '@/lib/cx';
import { formatMoney, ltrMoney } from '@/lib/money';
import { zoneDisplayName } from '@/features/settings/timeZones';
import styles from './ApprovalSheet.module.css';

type Kind<K extends ApprovalDetails['kind']> = Extract<ApprovalDetails, { kind: K }>;

/** An amount as one left-to-right, tabular run (so "149,00 $" never splits in RTL). */
export function MoneyText({ value, className }: { value: Money; className?: string }) {
  const { f } = useI18n();
  return (
    <span className={cx('tabular', styles.money, className)} dir="ltr">
      {formatMoney(value, f.intlLocale)}
    </span>
  );
}

function Row({ label, children, wide }: { label: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cx(styles.fieldRow, wide && styles.fieldRowWide)}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** "Fri, 6 Nov, 14:00–15:00" in `timeZone` (an all-day event: its dates only). */
export function useTimeRange() {
  const { f } = useI18n();
  return (start: string, end: string | null, timeZone: string, allDay = false): string => {
    const zone = safeZone(timeZone);
    if (allDay) {
      const fmt = new Intl.DateTimeFormat(f.intlLocale, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: zone,
      });
      // The end of an all-day event is the next midnight: the last day is the day before it.
      const last = end ? new Date(Date.parse(end) - 1) : null;
      return last && fmt.format(last) !== fmt.format(new Date(start))
        ? fmt.formatRange(new Date(start), last)
        : fmt.format(new Date(start));
    }
    const fmt = new Intl.DateTimeFormat(f.intlLocale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: zone,
    });
    return end ? fmt.formatRange(new Date(start), new Date(end)) : fmt.format(new Date(start));
  };
}

function safeZone(zone: string): string | undefined {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/**
 * When it happens, in the zone it is stored in (the approval's zone, named), plus the same time
 * in the account's zone when that differs — so a meeting in New York is never misread.
 */
function When({
  start,
  end,
  timeZone,
  allDay = false,
}: {
  start: string;
  end: string | null;
  timeZone: string;
  allDay?: boolean;
}) {
  const { t } = useI18n();
  const me = useMe();
  const range = useTimeRange();
  const mine = me.data?.timeZone;
  const local = mine && mine !== timeZone && !allDay ? range(start, end, mine) : null;
  const main = range(start, end, timeZone, allDay);
  return (
    <span className={styles.when}>
      <span className={cx(styles.whenMain, 'tabular')}>{main}</span>
      <span className={styles.whenZone}>
        {allDay ? t('approvals.calendar.allDay') : zoneDisplayName(timeZone)}
      </span>
      {local && local !== main && (
        <span className={styles.whenZone}>{t('approvals.calendar.yourTime', { time: local })}</span>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ calendar event */

export function CalendarEventDetails({ details }: { details: Kind<'calendar_event'> }) {
  const { t } = useI18n();
  const provider = PROVIDER_NAME[details.provider];
  return (
    <>
      <div className={styles.email}>
        <dl className={styles.fields}>
          <Row label={t('approvals.calendar.change')}>
            <Badge tone={details.action === 'cancel' ? 'warning' : 'neutral'} icon={CalendarClock}>
              {t(`approvals.calendar.actions.${details.action}`)}
            </Badge>
          </Row>
          <Row label={t('approvals.calendar.calendar')}>
            {provider} · <span className="ltr">{details.account}</span>
          </Row>
          <Row label={t('approvals.calendar.title')}>
            <UserText className={styles.subject}>{details.title}</UserText>
          </Row>
          <Row label={t('approvals.calendar.when')}>
            <When
              start={details.start}
              end={details.end}
              timeZone={details.timeZone}
              allDay={details.allDay}
            />
          </Row>
          {details.previous && (
            <Row label={t('approvals.calendar.previous')}>
              <span className={styles.previous}>
                <UserText>{details.previous.title}</UserText>
                <When
                  start={details.previous.start}
                  end={details.previous.end}
                  timeZone={details.timeZone}
                />
              </span>
            </Row>
          )}
          {details.location && (
            <Row label={t('approvals.calendar.location')}>
              <UserText>{details.location}</UserText>
            </Row>
          )}
          <Row
            label={
              <>
                {t('approvals.calendar.attendees')}
                <span className="visually-hidden">
                  {' '}
                  ({t('approvals.recipients', { count: details.attendees.length })})
                </span>
              </>
            }
          >
            {details.attendees.length === 0 ? (
              <span className={styles.muted}>{t('approvals.calendar.onlyYou')}</span>
            ) : (
              <>
                <ul className={styles.recipients}>
                  {details.attendees.map((address) => (
                    <li key={address} className={styles.recipient}>
                      <span className="ltr">{address}</span>
                    </li>
                  ))}
                </ul>
                <p className={styles.rowNote}>
                  <Icon icon={Users} size={16} />
                  {details.notifyAttendees
                    ? t(`approvals.calendar.notify.${details.action}`, { provider })
                    : t('approvals.calendar.noNotify')}
                </p>
              </>
            )}
          </Row>
        </dl>
        {details.description && (
          <div className={styles.bodyBlock}>
            <p className={styles.bodyLabel}>{t('approvals.calendar.description')}</p>
            <pre className={styles.body} dir="auto">
              {details.description}
            </pre>
          </div>
        )}
      </div>
      {details.conflictCheck && details.action !== 'cancel' && (
        <p className={styles.kindNote}>{t('approvals.calendar.conflictCheck')}</p>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ fields (booking, form) */

function SubmittedFields({
  fields,
}: {
  fields: ReadonlyArray<{ label: string; value: string; personal: boolean }>;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.email}>
      <p className={styles.bodyLabel}>{t('approvals.fields.sent')}</p>
      <dl className={styles.fields}>
        {fields.map((field) => (
          <div className={styles.fieldRow} key={field.label}>
            <dt>
              <UserText>{field.label}</UserText>
            </dt>
            <dd className={styles.fieldValue}>
              <span className={styles.genericValue} dir="auto">
                {field.value}
              </span>
              {field.personal && (
                <Badge icon={Lock} className={styles.personal}>
                  {t('approvals.fields.personal')}
                </Badge>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SiteRow({ name, host }: { name: string; host: string }) {
  return (
    <span className={styles.site}>
      <UserText className={styles.subject}>{name}</UserText>
      <span className={cx('ltr', styles.host)}>{host}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ booking */

export function BookingDetails({ details }: { details: Kind<'booking'> }) {
  const { t } = useI18n();
  return (
    <>
      <div className={styles.email}>
        <dl className={styles.fields}>
          <Row label={t('approvals.booking.site')}>
            <SiteRow name={details.siteName} host={details.siteHost} />
          </Row>
          <Row label={t('approvals.booking.service')}>
            <UserText className={styles.subject}>{details.service}</UserText>
          </Row>
          <Row label={t('approvals.booking.when')}>
            <When start={details.start} end={details.end} timeZone={details.timeZone} />
          </Row>
          <Row label={t('approvals.booking.price')}>
            {details.price ? (
              <MoneyText value={details.price} className={styles.subject} />
            ) : (
              <span className={styles.muted}>{t('approvals.booking.noPrice')}</span>
            )}
          </Row>
          <Row label={t('approvals.booking.binding')}>
            {details.binding ? (
              <Badge tone="warning" icon={CircleAlert}>
                {t('approvals.booking.bindingYes')}
              </Badge>
            ) : (
              <span>{t('approvals.booking.bindingNo')}</span>
            )}
          </Row>
        </dl>
        {details.cancellationTerms && (
          <div className={styles.bodyBlock}>
            <p className={styles.bodyLabel}>{t('approvals.booking.terms')}</p>
            <p className={styles.body} dir="auto">
              {details.cancellationTerms}
            </p>
          </div>
        )}
      </div>
      <SubmittedFields fields={details.fields} />
      {details.evidenceArtifactId && (
        <EvidenceImage
          artifact={{ id: details.evidenceArtifactId }}
          caption={t('approvals.booking.evidence', { site: details.siteName })}
        />
      )}
      <p className={styles.kindNote}>{t('approvals.booking.note')}</p>
    </>
  );
}

/* ------------------------------------------------------------------ purchase */

export function PurchaseDetails({ details }: { details: Kind<'purchase'> }) {
  const { t, f } = useI18n();
  const limit = details.limit;
  const monthly = limit.monthly.amountMicro;
  const spent = limit.spentThisMonth.amountMicro;
  const after = spent + details.total.amountMicro;
  const ltr = (m: Money) => ltrMoney(m, f.intlLocale);
  return (
    <>
      <div className={styles.email}>
        <dl className={styles.fields}>
          <Row label={t('approvals.purchase.merchant')}>
            <SiteRow name={details.merchant.name} host={details.merchant.host} />
          </Row>
        </dl>
        <div className={styles.tableWrap}>
          <table className={styles.items}>
            <caption className="visually-hidden">{t('approvals.purchase.items')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('approvals.purchase.item')}</th>
                <th scope="col" className={styles.num}>
                  {t('approvals.purchase.quantity')}
                </th>
                <th scope="col" className={cx(styles.num, styles.unitCol)}>
                  {t('approvals.purchase.unitPrice')}
                </th>
                <th scope="col" className={styles.num}>
                  {t('approvals.purchase.lineTotal')}
                </th>
              </tr>
            </thead>
            <tbody>
              {details.items.map((item, i) => (
                <tr key={`${item.productUrl}-${i}`}>
                  <th scope="row" className={styles.itemTitle}>
                    <UserText>{item.title}</UserText>
                    {/* Narrow screens: the unit price under the title (its column is hidden). */}
                    <span className={styles.unitInline}>
                      {t('approvals.purchase.each', {
                        price: ltrMoney(item.unitPrice, f.intlLocale),
                      })}
                    </span>
                  </th>
                  <td className={cx(styles.num, 'tabular')}>{f.number(item.quantity)}</td>
                  <td className={cx(styles.num, styles.unitCol)}>
                    <MoneyText value={item.unitPrice} />
                  </td>
                  <td className={styles.num}>
                    <MoneyText value={item.lineTotal} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className={styles.totals}>
          <div>
            <dt>{t('approvals.purchase.subtotal')}</dt>
            <dd>
              <MoneyText value={details.subtotal} />
            </dd>
          </div>
          <div>
            <dt>{t('approvals.purchase.shipping')}</dt>
            <dd>
              <MoneyText value={details.shipping} />
            </dd>
          </div>
          <div>
            <dt>{t('approvals.purchase.tax')}</dt>
            <dd>
              {details.tax ? (
                <MoneyText value={details.tax} />
              ) : (
                <span className={styles.muted}>{t('approvals.purchase.taxNotStated')}</span>
              )}
            </dd>
          </div>
          <div className={styles.grandTotal}>
            <dt>{t('approvals.purchase.total')}</dt>
            <dd>
              <MoneyText value={details.total} />
            </dd>
          </div>
        </dl>
        <dl className={cx(styles.fields, styles.purchaseFacts)}>
          <Row label={t('approvals.purchase.delivery')}>
            <span className={styles.stacked}>
              <UserText>
                {details.delivery.estimate
                  ? `${details.delivery.method} · ${details.delivery.estimate}`
                  : details.delivery.method}
              </UserText>
              <UserText className={styles.muted}>{details.delivery.address}</UserText>
            </span>
          </Row>
          <Row label={t('approvals.purchase.payment')}>
            <span className={styles.stacked}>
              <UserText>{details.paymentMethod}</UserText>
              <span className={styles.muted}>{t('approvals.purchase.paymentNote')}</span>
            </span>
          </Row>
        </dl>
      </div>

      <section className={styles.limit} aria-labelledby="purchase-limit-title">
        <div className={styles.limitHead}>
          <h3 id="purchase-limit-title" className={styles.whyTitle}>
            {t('approvals.purchase.limitTitle')}
          </h3>
          <span className={styles.limitValue}>
            <bdi>{t('approvals.purchase.limitOf', { limit: ltr(limit.monthly) })}</bdi>
          </span>
        </div>
        <div
          role="meter"
          aria-labelledby="purchase-limit-title"
          aria-valuemin={0}
          aria-valuemax={monthly}
          aria-valuenow={Math.min(after, monthly)}
          aria-valuetext={stripIsolates(
            t('approvals.purchase.limitMeter', {
              spent: ltr(limit.spentThisMonth),
              total: ltr(details.total),
              limit: ltr(limit.monthly),
            }),
          )}
          className={styles.limitMeter}
        >
          <span
            className={styles.limitSpent}
            style={{ inlineSize: `${monthly > 0 ? Math.min(100, (spent / monthly) * 100) : 0}%` }}
          />
          <span
            className={styles.limitThis}
            style={{
              inlineSize: `${monthly > 0 ? Math.min(100, (details.total.amountMicro / monthly) * 100) : 0}%`,
            }}
          />
        </div>
        <ul className={styles.limitLegend}>
          <li>
            <span className={cx(styles.swatch, styles.swatchSpent)} aria-hidden="true" />
            <bdi>{t('approvals.purchase.spent', { amount: ltr(limit.spentThisMonth) })}</bdi>
          </li>
          <li>
            <span className={cx(styles.swatch, styles.swatchThis)} aria-hidden="true" />
            <bdi>{t('approvals.purchase.thisOrder', { amount: ltr(details.total) })}</bdi>
          </li>
          <li>
            <bdi>{t('approvals.purchase.remaining', { amount: ltr(limit.remainingAfter) })}</bdi>
          </li>
        </ul>
      </section>

      {details.evidenceArtifactId && (
        <EvidenceImage
          artifact={{ id: details.evidenceArtifactId }}
          caption={t('approvals.purchase.evidence', { merchant: details.merchant.name })}
        />
      )}
      <p className={styles.kindNote}>{t('approvals.purchase.note')}</p>
    </>
  );
}

/* ------------------------------------------------------------------ form submission */

export function FormSubmissionDetails({ details }: { details: Kind<'form_submission'> }) {
  const { t } = useI18n();
  return (
    <>
      <div className={styles.email}>
        <dl className={styles.fields}>
          <Row label={t('approvals.form.site')}>
            <SiteRow name={details.siteName} host={details.siteHost} />
          </Row>
          <Row label={t('approvals.form.form')}>
            <span>{t('approvals.form.formName', { form: details.form })}</span>
          </Row>
          {details.binding && (
            <Row label={t('approvals.booking.binding')}>
              <Badge tone="warning" icon={CircleAlert}>
                {t('approvals.booking.bindingYes')}
              </Badge>
            </Row>
          )}
        </dl>
      </div>
      <SubmittedFields fields={details.fields} />
      {details.evidenceArtifactId && (
        <EvidenceImage
          artifact={{ id: details.evidenceArtifactId }}
          caption={t('approvals.form.evidence', { site: details.siteName })}
        />
      )}
      <p className={styles.kindNote}>{t('approvals.form.note')}</p>
    </>
  );
}
