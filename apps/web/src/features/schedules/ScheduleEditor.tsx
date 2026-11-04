'use client';

import type { Recurrence, Schedule, Weekday } from '@jarvis/contracts';
import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Select, TextArea, TextField } from '@/components/ui/Field';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { TimeZoneSelect } from '@/features/settings/TimeZoneSelect';
import { zoneDisplayName } from '@/features/settings/timeZones';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from '@/lib/cx';
import { useCreateSchedule, useSchedulePreview, useUpdateSchedule } from './api';
import {
  defaultRecurrence,
  describeRecurrence,
  formatInZone,
  sortMonthDays,
  sortWeekdays,
  WEEKDAYS,
  weekdayNames,
  withFrequency,
} from './recurrence';
import styles from './Schedules.module.css';

const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
const INTERVALS = Array.from({ length: 12 }, (_, i) => i + 1);
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

/**
 * Create or edit a schedule: a name, the request each run carries out, and a calm recurrence
 * picker — daily, weekly with weekday toggles, or monthly with day toggles — at a local time in
 * a time zone the server accepts. The next runs come from the server (preview), in that zone.
 * An end (until / count) set elsewhere is kept as it is.
 */
export function ScheduleEditor({
  schedule,
  defaultTimeZone,
  onClose,
}: {
  /** The schedule to edit; null creates a new one. */
  schedule: Schedule | null;
  defaultTimeZone: string;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const { t, f } = i18n;
  const { toast } = useToast();
  const create = useCreateSchedule();
  const update = useUpdateSchedule(schedule?.id ?? 'new');
  const mutation = schedule ? update : create;
  const titleRef = useRef<HTMLInputElement>(null);
  const daysLegendId = useId();
  const [title, setTitle] = useState(schedule?.title ?? '');
  const [request, setRequest] = useState(schedule?.request ?? '');
  const [recurrence, setRecurrence] = useState<Recurrence>(
    schedule?.recurrence ?? defaultRecurrence(defaultTimeZone),
  );
  const [submitted, setSubmitted] = useState(false);
  const preview = useSchedulePreview(recurrence);

  const shortNames = useMemo(() => weekdayNames(f.intlLocale, 'short'), [f.intlLocale]);
  const longNames = useMemo(() => weekdayNames(f.intlLocale, 'long'), [f.intlLocale]);
  const days = recurrence.byWeekday ?? [];
  const monthDays = recurrence.byMonthDay ?? [];

  const errors = {
    title: title.trim() ? null : t('schedules.editor.nameRequired'),
    request: request.trim() ? null : t('schedules.editor.requestRequired'),
    days:
      (recurrence.frequency === 'weekly' && days.length === 0) ||
      (recurrence.frequency === 'monthly' && monthDays.length === 0)
        ? t('schedules.editor.daysRequired')
        : null,
  };
  const valid = !errors.title && !errors.request && !errors.days;

  const toggleWeekday = (day: Weekday) => {
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
    setRecurrence({ ...recurrence, byWeekday: sortWeekdays(next) });
  };
  const toggleMonthDay = (day: number) => {
    const next = monthDays.includes(day) ? monthDays.filter((d) => d !== day) : [...monthDays, day];
    setRecurrence({ ...recurrence, byMonthDay: sortMonthDays(next) });
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setSubmitted(true);
    if (!valid || mutation.isPending) return;
    const body = { title: title.trim(), request: request.trim(), recurrence };
    const done = () => {
      toast({ message: schedule ? t('schedules.toasts.saved') : t('schedules.toasts.created') });
      onClose();
    };
    if (schedule) update.mutate(body, { onSuccess: done });
    else create.mutate(body, { onSuccess: done });
  };

  const occurrences = preview.data?.occurrences ?? [];
  const zone = preview.data?.timeZone ?? recurrence.timeZone;

  return (
    <Dialog
      open
      size="lg"
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
      title={schedule ? t('schedules.editor.editTitle') : t('schedules.editor.createTitle')}
      initialFocusRef={titleRef}
      dismissible={!mutation.isPending}
      busy={mutation.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            {t('common.actions.cancel')}
          </Button>
          <Button type="submit" form="schedule-editor" variant="primary" loading={mutation.isPending}>
            {schedule ? t('schedules.editor.save') : t('schedules.editor.create')}
          </Button>
        </>
      }
    >
      <form id="schedule-editor" className={styles.editor} onSubmit={submit} noValidate>
        {mutation.isError && <ErrorBanner error={mutation.error} />}
        <TextField
          ref={titleRef}
          label={t('schedules.editor.name')}
          placeholder={t('schedules.editor.namePlaceholder')}
          value={title}
          maxLength={120}
          dir={title ? 'auto' : undefined}
          error={submitted ? errors.title : undefined}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <TextArea
          label={t('schedules.editor.request')}
          placeholder={t('schedules.editor.requestPlaceholder')}
          hint={t('schedules.editor.requestHint')}
          value={request}
          maxLength={4000}
          rows={3}
          maxRows={8}
          dir={request ? 'auto' : undefined}
          error={submitted ? errors.request : undefined}
          onChange={(e) => setRequest(e.target.value)}
          required
        />

        <div className={styles.recurrence}>
          <div className={styles.frequencyRow}>
            <SegmentedControl
              legend={t('schedules.editor.frequencyLegend')}
              showLegend
              options={FREQUENCIES.map((value) => ({
                value,
                label: t(`schedules.editor.frequency.${value}`),
              }))}
              value={recurrence.frequency}
              onChange={(frequency) => setRecurrence(withFrequency(recurrence, frequency))}
              name="schedule-frequency"
            />
            <Select
              label={t('schedules.editor.interval')}
              size="sm"
              value={String(recurrence.interval ?? 1)}
              onChange={(e) => setRecurrence({ ...recurrence, interval: Number(e.target.value) })}
              fieldClassName={styles.interval}
            >
              {INTERVALS.map((n) => (
                <option key={n} value={n}>
                  {t(`schedules.editor.intervalOption.${recurrence.frequency}`, { count: n })}
                </option>
              ))}
            </Select>
          </div>

          {recurrence.frequency === 'weekly' && (
            <fieldset className={styles.dayPicker} aria-describedby={submitted && errors.days ? daysLegendId : undefined}>
              <legend className={styles.legend}>{t('schedules.editor.daysLegend')}</legend>
              <div className={styles.weekdays}>
                {WEEKDAYS.map((day) => {
                  const on = days.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      className={cx(styles.dayToggle, on && styles.dayOn)}
                      aria-pressed={on}
                      aria-label={longNames[day]}
                      onClick={() => toggleWeekday(day)}
                    >
                      {shortNames[day]}
                    </button>
                  );
                })}
              </div>
              {submitted && errors.days && (
                <p id={daysLegendId} className={styles.fieldError}>
                  {errors.days}
                </p>
              )}
            </fieldset>
          )}

          {recurrence.frequency === 'monthly' && (
            <fieldset className={styles.dayPicker} aria-describedby={submitted && errors.days ? daysLegendId : undefined}>
              <legend className={styles.legend}>{t('schedules.editor.dayOfMonth')}</legend>
              <div className={styles.monthDays}>
                {MONTH_DAYS.map((day) => {
                  const on = monthDays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      className={cx(styles.dayToggle, styles.monthDay, on && styles.dayOn)}
                      aria-pressed={on}
                      onClick={() => toggleMonthDay(day)}
                    >
                      <span className="tabular">{f.number(day)}</span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  className={cx(styles.dayToggle, styles.lastDay, monthDays.includes(-1) && styles.dayOn)}
                  aria-pressed={monthDays.includes(-1)}
                  onClick={() => toggleMonthDay(-1)}
                >
                  {t('schedules.editor.lastDay')}
                </button>
              </div>
              <p className={styles.legendHint}>{t('schedules.editor.dayOfMonthHint')}</p>
              {submitted && errors.days && (
                <p id={daysLegendId} className={styles.fieldError}>
                  {errors.days}
                </p>
              )}
            </fieldset>
          )}

          <div className={styles.timeRow}>
            <TextField
              type="time"
              label={t('schedules.editor.time')}
              value={recurrence.time}
              required
              onChange={(e) => {
                if (/^\d{2}:\d{2}$/.test(e.target.value))
                  setRecurrence({ ...recurrence, time: e.target.value });
              }}
              fieldClassName={styles.time}
            />
            <div className={styles.zone}>
              <TimeZoneSelect
                label={t('schedules.editor.timeZone')}
                value={recurrence.timeZone}
                onChange={(timeZone) => setRecurrence({ ...recurrence, timeZone })}
              />
            </div>
          </div>
        </div>

        <section className={styles.preview} aria-busy={preview.isFetching || undefined}>
          <h3 className={styles.previewTitle}>{t('schedules.editor.preview')}</h3>
          {!errors.days && (
            <p className={styles.previewSentence} aria-live="polite">
              {describeRecurrence(recurrence, i18n)}
            </p>
          )}
          {preview.isError ? (
            <ErrorBanner error={preview.error} />
          ) : errors.days ? null : preview.isPending ? (
            <div className={styles.previewSkeleton} aria-hidden="true">
              <Skeleton width="60%" height={14} />
              <Skeleton width="55%" height={14} />
              <Skeleton width="58%" height={14} />
            </div>
          ) : occurrences.length === 0 ? (
            <p className={styles.previewNote}>{t('schedules.editor.previewNone')}</p>
          ) : (
            <>
              <ol className={styles.occurrences}>
                {occurrences.map((at) => (
                  <li key={at} className="tabular">
                    <time dateTime={at}>{formatInZone(at, zone, f.intlLocale)}</time>
                  </li>
                ))}
              </ol>
              <p className={styles.previewNote}>{zoneDisplayName(zone)}</p>
            </>
          )}
        </section>
      </form>
    </Dialog>
  );
}
