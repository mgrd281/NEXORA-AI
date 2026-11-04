'use client';

import type { ApprovalDetails } from '@jarvis/contracts';
import { CircleAlert, Lock, PhoneForwarded, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Icon } from '@/components/ui/Icon';
import { UserText } from '@/components/ui/UserText';
import { LANGUAGE_NAMES } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from '@/lib/cx';
import { zoneDisplayName } from '@/features/settings/timeZones';
import { MoneyText } from './PhaseCDetails';
import styles from './ApprovalSheet.module.css';

type PhoneCall = Extract<ApprovalDetails, { kind: 'phone_call' }>;

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.fieldRow}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** "Tue, 10 Nov 2026" for a calendar date (no time zone shift: it is the callee's date). */
export function useCalendarDate() {
  const { f } = useI18n();
  return (date: string) =>
    new Intl.DateTimeFormat(f.intlLocale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${date}T00:00:00Z`));
}

/** "14:30" / "2:30 PM" for a local time "HH:MM", in the viewer's notation. */
export function useLocalTime() {
  const { f } = useI18n();
  return (time: string) =>
    new Intl.DateTimeFormat(f.intlLocale, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(new Date(`1970-01-01T${time}:00Z`));
}

/** A region code as its name in the viewer's language ("DE" → "Germany"). */
export function useRegionName() {
  const { f } = useI18n();
  return (code: string | null) => {
    if (!code) return null;
    try {
      return new Intl.DisplayNames([f.intlLocale], { type: 'region' }).of(code) ?? code;
    } catch {
      return code;
    }
  };
}

/**
 * Everything the user must see before JARVIS calls someone (docs/architecture/phase-d.md
 * §3.2): whom, from which number, for whom, in which language, for what — and the exact words
 * of the script, what personal details it may share, how long, when, recording, voicemail,
 * transfer and cost. Approved by a tap / click only (never by voice).
 */
export function PhoneCallDetails({ details }: { details: PhoneCall }) {
  const { t, f } = useI18n();
  const date = useCalendarDate();
  const time = useLocalTime();
  const region = useRegionName();
  const language = LANGUAGE_NAMES[details.language];
  const script = details.script;
  const country = region(details.country);
  return (
    <>
      <div className={styles.email}>
        <dl className={styles.fields}>
          <Row label={t('approvals.call.callee')}>
            <span className={styles.stacked}>
              {details.calleeName ? (
                <UserText className={styles.subject}>{details.calleeName}</UserText>
              ) : (
                <span className={styles.muted}>{t('approvals.call.numberUnnamed')}</span>
              )}
              <span className={cx('ltr', 'tabular', styles.phone)}>{details.toDisplay}</span>
              {country && <span className={styles.muted}>{country}</span>}
            </span>
          </Row>
          <Row label={t('approvals.call.onBehalfOf')}>
            <UserText>{details.onBehalfOf}</UserText>
          </Row>
          <Row label={t('approvals.call.callerId')}>
            {details.callerId ? (
              <span className={cx('ltr', 'tabular')}>
                {details.callerIdDisplay ?? details.callerId}
              </span>
            ) : (
              <span className={styles.muted}>{t('approvals.call.callerIdUnknown')}</span>
            )}
          </Row>
          <Row label={t('approvals.call.language')}>
            <span lang={details.language}>{language}</span>
          </Row>
          <Row label={t('approvals.call.purpose')}>
            <span className={styles.stacked}>
              <span>{t(`approvals.call.purposes.${details.purpose}`)}</span>
              <UserText className={styles.muted}>{details.goal}</UserText>
            </span>
          </Row>
          {details.date && (
            <Row label={t('approvals.call.when')}>
              <span className={styles.stacked}>
                <span className="tabular">{date(details.date)}</span>
                <span className={styles.muted}>
                  {details.window
                    ? t('approvals.call.window', {
                        start: time(details.window.start),
                        end: time(details.window.end),
                      })
                    : t('approvals.call.anyTime')}
                </span>
              </span>
            </Row>
          )}
          {details.binding && (
            <Row label={t('approvals.call.binding')}>
              <Badge tone="warning" icon={CircleAlert}>
                {t('approvals.call.bindingYes')}
              </Badge>
            </Row>
          )}
        </dl>
      </div>

      {/* The exact words, in the call's language (the action hash covers them). */}
      <section className={styles.email} aria-labelledby="call-script-title">
        <p className={styles.bodyLabel} id="call-script-title">
          {t('approvals.call.script')}
        </p>
        <p className={cx(styles.rowNote, styles.scriptNote)}>
          <Icon icon={ShieldCheck} size={16} />
          {t('approvals.call.scriptNote', { language, name: details.onBehalfOf })}
        </p>
        <ol className={styles.script}>
          <ScriptLine label={t('approvals.call.lines.opening')} lang={details.language}>
            {script.opening}
          </ScriptLine>
          {script.recordingQuestion && (
            <ScriptLine label={t('approvals.call.lines.recordingQuestion')} lang={details.language}>
              {script.recordingQuestion}
            </ScriptLine>
          )}
          {script.message && (
            <ScriptLine label={t('approvals.call.lines.message')} lang={details.language}>
              {script.message}
            </ScriptLine>
          )}
          {script.questions.map((q, i) => (
            <ScriptLine
              key={i}
              label={t('approvals.call.lines.question', { n: i + 1 })}
              lang={details.language}
            >
              {q}
            </ScriptLine>
          ))}
          <ScriptLine label={t('approvals.call.lines.closing')} lang={details.language}>
            {script.closing}
          </ScriptLine>
          {script.voicemailMessage && (
            <ScriptLine label={t('approvals.call.lines.voicemail')} lang={details.language}>
              {script.voicemailMessage}
            </ScriptLine>
          )}
        </ol>
      </section>

      <div className={styles.email}>
        <dl className={styles.fields}>
          <Row label={t('approvals.call.dialog')}>
            {t(`approvals.call.dialogs.${details.dialog}`)}
          </Row>
          <Row label={t('approvals.call.shared')}>
            {details.shareInfo.length === 0 ? (
              <span className={styles.muted}>{t('approvals.call.sharedNone')}</span>
            ) : (
              <span className={styles.stacked}>
                <ul className={styles.shared}>
                  {details.shareInfo.map((item) => (
                    <li key={`${item.label}:${item.value}`} className={styles.sharedItem}>
                      <UserText className={styles.sharedLabel}>{item.label}</UserText>
                      <span dir="auto" className={styles.sharedValue}>
                        {item.value}
                      </span>
                      <Badge icon={Lock} className={styles.personal}>
                        {t('approvals.fields.personal')}
                      </Badge>
                    </li>
                  ))}
                </ul>
                <span className={styles.muted}>{t('approvals.call.sharedNote')}</span>
              </span>
            )}
          </Row>
          <Row label={t('approvals.call.duration')}>
            <span className="tabular">{f.duration(details.maxDurationSeconds * 1000)}</span>
          </Row>
          <Row label={t('approvals.call.hours')}>
            <span className="tabular">
              {t('approvals.call.hoursValue', {
                start: time(details.allowedHours.start),
                end: time(details.allowedHours.end),
                zone: zoneDisplayName(details.allowedHours.timeZone),
              })}
            </span>
          </Row>
          <Row label={t('approvals.call.recording')}>
            {details.recording === 'off' ? (
              t('approvals.call.recordings.off')
            ) : (
              <Badge tone="warning">{t(`approvals.call.recordings.${details.recording}`)}</Badge>
            )}
          </Row>
          <Row label={t('approvals.call.voicemail')}>
            {t(`approvals.call.voicemails.${details.voicemail}`)}
          </Row>
          <Row label={t('approvals.call.transfer')}>
            {details.transfer.allowed && details.transfer.to ? (
              <span className={styles.rowNote}>
                <Icon icon={PhoneForwarded} size={16} />
                <span>
                  {t('approvals.call.transferTo', {
                    number: `⁦${details.transfer.to}⁩`,
                  })}
                </span>
              </span>
            ) : (
              t('approvals.call.transferNo')
            )}
          </Row>
          <Row label={t('approvals.call.cost')}>
            {details.costEstimate ? (
              <MoneyText value={details.costEstimate} />
            ) : (
              <span className={styles.muted}>{t('approvals.call.costUnknown')}</span>
            )}
          </Row>
        </dl>
      </div>
      <p className={styles.kindNote}>{t('approvals.call.note')}</p>
    </>
  );
}

function ScriptLine({ label, lang, children }: { label: string; lang: string; children: string }) {
  return (
    <li className={styles.scriptLine}>
      <span className={styles.scriptLabel}>{label}</span>
      {/* The words as spoken: in the call's language and its own direction. */}
      <blockquote className={styles.scriptText} lang={lang} dir="auto">
        {children}
      </blockquote>
    </li>
  );
}
