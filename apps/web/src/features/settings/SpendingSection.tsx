'use client';

import type { Booking, Me, Money, Order } from '@jarvis/contracts';
import { COMMERCE_LIMITS } from '@jarvis/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { CalendarCheck, CircleSlash, PackageCheck, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useId, useRef, useState, type FormEvent } from 'react';
import { MoneyText, useTimeRange } from '@/components/approvals/PhaseCDetails';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/Skeleton';
import { UserText } from '@/components/ui/UserText';
import { useI18n } from '@/i18n/I18nProvider';
import { api } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import { cx } from '@/lib/cx';
import { useNow } from '@/lib/hooks/useNow';
import { ltrMoney, usd } from '@/lib/money';
import { ExactTime } from '@/features/tasks/format';
import {
  BookingStatusPill,
  FileLink,
  OrderStatusPill,
  useFailureLine,
} from '@/features/tasks/phase-c/PhaseCResults';
import { formatBudgetInput, parseBudget } from './budget';
import { useSaveMe } from './api';
import { SaveStatus, SettingRow, SettingsCard } from './controls';
import { committedThisMonth } from './spending';
import { SettingsSection } from './SettingsSection';
import styles from './settings.module.css';

const PAGE = 20;

export function useOrders() {
  return useInfiniteQuery({
    queryKey: qk.orders.list,
    queryFn: ({ pageParam, signal }) =>
      api.call('listOrders', {
        query: { limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useBookings() {
  return useInfiniteQuery({
    queryKey: qk.bookings.list,
    queryFn: ({ pageParam, signal }) =>
      api.call('listBookings', {
        query: { limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

/**
 * Settings › Spending: the monthly purchase limit (0, the default, turns purchases off) with
 * exactly what it covers, this month's committed purchases, and the orders and bookings JARVIS
 * placed or tried to place — each with its real status and a link to its task.
 */
export function SpendingSection({ me }: { me: Me }) {
  const { t } = useI18n();
  return (
    <SettingsSection
      id="spending"
      title={t('settings.sections.spending')}
      description={t('settings.spending.description')}
    >
      <SettingsCard>
        <LimitRow me={me} />
      </SettingsCard>
      <SettingsCard>
        <OrdersRow />
      </SettingsCard>
      <SettingsCard>
        <BookingsRow />
      </SettingsCard>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------ limit */

function LimitRow({ me }: { me: Me }) {
  const { t, f, locale } = useI18n();
  const saver = useSaveMe();
  const saved = me.preferences.spending.monthlyPurchaseLimitUsd ?? 0;
  const [draft, setDraft] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const value = draft ?? formatBudgetInput(saved, locale);
  const parsed = parseBudget(value, locale);
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const statusId = useId();
  const orders = useOrders();
  const paidBookings = useBookings();
  const now = useNow();
  const committed =
    orders.data && paidBookings.data && now !== 0
      ? committedThisMonth(
          orders.data.pages.flatMap((p) => p.items),
          me.timeZone,
          now,
          paidBookings.data.pages.flatMap((p) => p.items),
        )
      : null;

  function commit() {
    if (draft === null) return;
    setTouched(true);
    if (parsed === null) return;
    if (parsed === saved) {
      setDraft(null);
      return;
    }
    if (saver.pending) return;
    saver.save(
      { preferences: { spending: { monthlyPurchaseLimitUsd: parsed } } },
      { onSuccess: () => setDraft((d) => (d === value ? null : d)) },
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (parsed === null) {
      setTouched(true);
      inputRef.current?.focus();
      return;
    }
    commit();
  }

  const limit = usd(saved);
  const left =
    committed !== null
      ? ({
          amountMicro: Math.max(0, limit.amountMicro - committed.amountMicro),
          currency: 'USD',
        } satisfies Money)
      : null;

  return (
    <SettingRow>
      <form onSubmit={submit} noValidate>
        <TextField
          ref={inputRef}
          label={t('settings.spending.limit')}
          aria-describedby={`${statusId} ${hintId}`}
          error={
            touched && parsed === null
              ? t('settings.spending.limitInvalid', {
                  max: f.number(COMMERCE_LIMITS.monthlyPurchaseLimitUsdMax),
                })
              : undefined
          }
          value={value}
          inputMode="decimal"
          enterKeyHint="done"
          autoComplete="off"
          dir="ltr"
          fieldClassName={styles.budgetField}
          trailing={
            <span className={styles.unit} aria-hidden="true">
              {t('settings.assistant.budgetUnit')}
            </span>
          }
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && draft !== null) {
              e.preventDefault();
              setDraft(null);
              setTouched(false);
            }
          }}
        />
      </form>
      <p id={statusId} className={cx(styles.limitStatus, saved === 0 && styles.limitOff)}>
        <Icon icon={saved === 0 ? CircleSlash : ShieldCheck} size={16} />
        {saved === 0 ? (
          <span>{t('settings.spending.off')}</span>
        ) : (
          <bdi>
            {committed && left
              ? t('settings.spending.on', {
                  limit: ltrMoney(limit, f.intlLocale),
                  spent: ltrMoney(committed, f.intlLocale),
                  left: ltrMoney(left, f.intlLocale),
                })
              : t('settings.spending.onShort', { limit: ltrMoney(limit, f.intlLocale) })}
          </bdi>
        )}
      </p>
      <ul id={hintId} className={styles.limitFacts}>
        <li>{t('settings.spending.facts.covers')}</li>
        <li>{t('settings.spending.facts.approval')}</li>
        <li>{t('settings.spending.facts.counts')}</li>
        <li>{t('settings.spending.facts.currency')}</li>
      </ul>
      <SaveStatus state={saver.state} error={saver.error} />
    </SettingRow>
  );
}

/* ------------------------------------------------------------------ orders, bookings */

function OrdersRow() {
  const { t } = useI18n();
  const orders = useOrders();
  const items = orders.data?.pages.flatMap((p) => p.items) ?? [];
  const titleId = useId();
  return (
    <SettingRow>
      <h3 id={titleId} className={styles.rowTitle}>
        {t('settings.spending.orders')}
      </h3>
      {orders.isPending ? (
        <ListSkeleton />
      ) : orders.isError && !orders.data ? (
        <ErrorBanner error={orders.error} onRetry={() => void orders.refetch()} />
      ) : items.length === 0 ? (
        <p className={styles.rowText}>{t('settings.spending.noOrders')}</p>
      ) : (
        <ul className={styles.records} aria-labelledby={titleId}>
          {items.map((order) => (
            <OrderItem key={order.id} order={order} />
          ))}
        </ul>
      )}
      {orders.hasNextPage && (
        <Button
          size="sm"
          loading={orders.isFetchingNextPage}
          onClick={() => void orders.fetchNextPage()}
        >
          {t('settings.spending.more')}
        </Button>
      )}
    </SettingRow>
  );
}

function OrderItem({ order }: { order: Order }) {
  const { t } = useI18n();
  const failureLine = useFailureLine();
  const first = order.items[0];
  const more = order.items.length - 1;
  return (
    <li className={styles.record}>
      <span className={styles.recordIcon} aria-hidden="true">
        <Icon icon={PackageCheck} size={20} />
      </span>
      <div className={styles.recordMain}>
        <p className={styles.recordTitle}>
          {first && <UserText>{first.title}</UserText>}
          {more > 0 && (
            <span className={styles.note}>
              {' '}
              {t('settings.spending.moreItems', { count: more })}
            </span>
          )}
        </p>
        <p className={styles.note}>
          <UserText>{order.merchantName}</UserText>
          {' · '}
          <ExactTime value={order.placedAt ?? order.createdAt} />
          {order.merchantOrderId && (
            <>
              {' · '}
              <span className="ltr">{order.merchantOrderId}</span>
            </>
          )}
        </p>
        {order.failureReason && <p className={styles.note}>{failureLine(order.failureReason)}</p>}
        {order.taskId && (
          <Link href={`/tasks/${order.taskId}`} className={styles.recordLink}>
            {t('settings.spending.openTask')}
          </Link>
        )}
      </div>
      <div className={styles.recordEnd}>
        <MoneyText value={order.total} className={styles.recordAmount} />
        <OrderStatusPill status={order.status} />
      </div>
    </li>
  );
}

function BookingsRow() {
  const { t } = useI18n();
  const bookings = useBookings();
  const items = bookings.data?.pages.flatMap((p) => p.items) ?? [];
  const titleId = useId();
  return (
    <SettingRow>
      <h3 id={titleId} className={styles.rowTitle}>
        {t('settings.spending.bookings')}
      </h3>
      {bookings.isPending ? (
        <ListSkeleton />
      ) : bookings.isError && !bookings.data ? (
        <ErrorBanner error={bookings.error} onRetry={() => void bookings.refetch()} />
      ) : items.length === 0 ? (
        <p className={styles.rowText}>{t('settings.spending.noBookings')}</p>
      ) : (
        <ul className={styles.records} aria-labelledby={titleId}>
          {items.map((booking) => (
            <BookingItem key={booking.id} booking={booking} />
          ))}
        </ul>
      )}
      {bookings.hasNextPage && (
        <Button
          size="sm"
          loading={bookings.isFetchingNextPage}
          onClick={() => void bookings.fetchNextPage()}
        >
          {t('settings.spending.more')}
        </Button>
      )}
    </SettingRow>
  );
}

function BookingItem({ booking }: { booking: Booking }) {
  const { t } = useI18n();
  const failureLine = useFailureLine();
  const range = useTimeRange();
  const ics = booking.evidence.find((a) => a.kind === 'ics');
  return (
    <li className={styles.record}>
      <span className={styles.recordIcon} aria-hidden="true">
        <Icon icon={CalendarCheck} size={20} />
      </span>
      <div className={styles.recordMain}>
        <p className={styles.recordTitle}>
          <UserText>{booking.service}</UserText>
          {' · '}
          <UserText>{booking.siteName}</UserText>
        </p>
        <p className={cx(styles.note, 'tabular')}>
          {range(booking.start, booking.end, booking.timeZone)}
          {booking.reference && (
            <>
              {' · '}
              <span className="ltr">{booking.reference}</span>
            </>
          )}
        </p>
        {booking.failureReason && (
          <p className={styles.note}>{failureLine(booking.failureReason)}</p>
        )}
        <span className={styles.recordLinks}>
          {ics && <FileLink artifact={ics} label={t('tasks.phaseC.booking.ics')} />}
          {booking.taskId && (
            <Link href={`/tasks/${booking.taskId}`} className={styles.recordLink}>
              {t('settings.spending.openTask')}
            </Link>
          )}
        </span>
      </div>
      <div className={styles.recordEnd}>
        {booking.price && <MoneyText value={booking.price} className={styles.recordAmount} />}
        <BookingStatusPill status={booking.status} />
      </div>
    </li>
  );
}

function ListSkeleton() {
  const { t } = useI18n();
  return (
    <div className={styles.skeletonBody} aria-busy="true">
      <span className="visually-hidden" role="status">
        {t('common.status.loading')}
      </span>
      <Skeleton width="60%" height={16} />
      <Skeleton width="40%" height={12} />
    </div>
  );
}
