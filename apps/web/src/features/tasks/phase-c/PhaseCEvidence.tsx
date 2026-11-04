'use client';

import type { LucideIcon } from 'lucide-react';
import {
  BellRing,
  CalendarCheck,
  CalendarSearch,
  Camera,
  FileCode,
  FileDown,
  FilePen,
  Hand,
  MailCheck,
  MailSearch,
  FileAudio,
  PackageCheck,
  PhoneCall,
  PhoneForwarded,
  PhoneOff,
  ScrollText,
  Server,
  ShieldCheck,
  ShoppingCart,
} from 'lucide-react';
import Link from 'next/link';
import { createContext, useContext } from 'react';
import { EvidenceImage } from '@/components/evidence/EvidenceImage';
import { CopyButton } from '@/components/ui/CopyButton';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useI18n } from '@/i18n/I18nProvider';
import { PROVIDER_NAME } from '@/i18n/server-message';
import { CallResult, ConnectionProvider } from '@jarvis/contracts';
import { cx } from '@/lib/cx';
import { ltrMoney, parseMoneyParam } from '@/lib/money';
import styles from '../Evidence.module.css';
import { safeExternalUrl, shortHash, type PhaseCEvidenceCode } from '../model';
import { evidenceHref } from '@/components/evidence/EvidenceImage';

export const PHASE_C_EVIDENCE_ICON: Record<PhaseCEvidenceCode, LucideIcon> = {
  PROVIDER_RESPONSE: Server,
  MAIL_SEARCH: MailSearch,
  MAIL_SENT: MailCheck,
  MAIL_DRAFT: FilePen,
  EMAIL_WATCH: BellRing,
  CALENDAR_EVENT: CalendarCheck,
  FREE_BUSY: CalendarSearch,
  SCREENSHOT: Camera,
  PAGE_EXTRACT: FileCode,
  ICS_FILE: FileDown,
  BOOKING_CONFIRMATION: CalendarCheck,
  ORDER_CONFIRMATION: PackageCheck,
  CART_SNAPSHOT: ShoppingCart,
  HANDOVER: Hand,
  // Phase D
  CALL_PLACED: PhoneCall,
  CALL_ENDED: PhoneOff,
  AI_DISCLOSED: ShieldCheck,
  RECORDING_CONSENT: ShieldCheck,
  CALL_TRANSCRIPT: ScrollText,
  CALL_RECORDING: FileAudio,
  CALL_TRANSFER: PhoneForwarded,
  DO_NOT_CALL_RECORDED: PhoneOff,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/**
 * The body of a Phase C evidence record, from its code and params (contracts EvidenceCode): the
 * provider and what it answered, ids to copy, a screenshot thumbnail, the ICS file, the merchant's
 * order number, or where the user took over. Never content (no mail text, no page text).
 */
/**
 * Evidence files the task page already shows under "What JARVIS saw on the sites" (the
 * browser sessions section, id `browser-sessions`): the proof list links there instead of
 * showing the same screenshot a second time.
 */
export const SessionArtifactsContext = createContext<ReadonlySet<string>>(new Set());
export const BROWSER_SESSIONS_ANCHOR = 'browser-sessions';

export function PhaseCEvidence({
  code,
  params: p,
}: {
  code: PhaseCEvidenceCode;
  params: Record<string, string | number>;
}) {
  const { t, f } = useI18n();
  const shownBelow = useContext(SessionArtifactsContext);
  const provider = ConnectionProvider.safeParse(p.provider);
  const providerName = provider.success ? PROVIDER_NAME[provider.data] : null;
  const id = (label: string, value: string | null) =>
    value ? (
      <div className={styles.valueRow}>
        <span className={styles.valueLabel}>{label}</span>
        <code className={cx(styles.value, 'ltr')} title={value}>
          {value.length > 24 ? shortHash(value, 10, 6) : value}
        </code>
        <CopyButton value={value} label={label} />
      </div>
    ) : null;
  switch (code) {
    case 'PROVIDER_RESPONSE':
      return (
        <p className={styles.detail}>
          {t('tasks.evidence.phaseC.providerResponse', {
            provider: providerName ?? '—',
            status: p.status ?? '—',
          })}
        </p>
      );
    case 'MAIL_SEARCH':
      return (
        <p className={styles.detail}>
          {t('tasks.evidence.phaseC.mailSearch', {
            provider: providerName ?? '—',
            count: Number(p.threads ?? 0),
          })}
        </p>
      );
    case 'MAIL_SENT':
      return (
        <>
          <p className={styles.detail}>
            {t('tasks.evidence.phaseC.mailSent', { provider: providerName ?? '—' })}
          </p>
          {id(t('tasks.evidence.messageId'), str(p.messageId))}
        </>
      );
    case 'MAIL_DRAFT':
      return (
        <>
          <p className={styles.detail}>
            {t('tasks.evidence.phaseC.mailDraft', { provider: providerName ?? '—' })}
          </p>
          {id(t('tasks.evidence.phaseC.draftId'), str(p.draftId))}
        </>
      );
    case 'EMAIL_WATCH':
      return str(p.expiresAt) ? (
        <p className={styles.detail}>
          <RelativeTime
            value={String(p.expiresAt)}
            format={(time) => t('tasks.evidence.phaseC.watchUntil', { time })}
          />{' '}
          <Link href="/settings#replies">{t('tasks.evidence.phaseC.watchManage')}</Link>
        </p>
      ) : null;
    case 'CALENDAR_EVENT':
      return (
        <>
          <p className={styles.detail}>
            {t('tasks.evidence.phaseC.calendarEvent', {
              provider: providerName ?? '—',
              action: String(p.action ?? 'create'),
            })}
          </p>
          {id(t('tasks.evidence.phaseC.eventId'), str(p.eventId))}
        </>
      );
    case 'FREE_BUSY':
      return (
        <p className={styles.detail}>
          {t('tasks.evidence.phaseC.freeBusy', {
            calendars: Number(p.calendars ?? 0),
            slots: Number(p.slots ?? 0),
          })}
        </p>
      );
    case 'SCREENSHOT': {
      const artifactId = str(p.artifactId);
      const url = safeExternalUrl(str(p.url));
      if (artifactId && shownBelow.has(artifactId))
        return (
          <p className={styles.detail}>
            <a href={`#${BROWSER_SESSIONS_ANCHOR}`}>
              {t('tasks.evidence.phaseC.screenshotBelow', {
                section: t('tasks.phaseC.sessions.title'),
              })}
            </a>
          </p>
        );
      return artifactId && UUID.test(artifactId) ? (
        <div className={styles.shot}>
          <EvidenceImage
            artifact={{ id: artifactId, pageUrl: url }}
            caption={t('tasks.evidence.phaseC.screenshotCaption')}
            size="sm"
          />
        </div>
      ) : null;
    }
    case 'PAGE_EXTRACT':
      return (
        <p className={styles.detail}>
          {t('tasks.evidence.phaseC.pageExtract', { count: Number(p.items ?? 0) })}
        </p>
      );
    case 'ICS_FILE': {
      const artifactId = str(p.artifactId);
      return artifactId && UUID.test(artifactId) ? (
        <p className={styles.detail}>
          <a href={evidenceHref({ id: artifactId })} download>
            {t('tasks.phaseC.booking.ics')}
          </a>
        </p>
      ) : null;
    }
    case 'BOOKING_CONFIRMATION':
      return id(t('tasks.phaseC.booking.reference'), str(p.reference));
    case 'ORDER_CONFIRMATION': {
      const total = parseMoneyParam(p.total);
      return (
        <>
          {total && (
            <p className={styles.detail}>
              <bdi>
                {t('tasks.evidence.phaseC.orderTotal', { total: ltrMoney(total, f.intlLocale) })}
              </bdi>
            </p>
          )}
          {id(t('tasks.phaseC.order.number'), str(p.merchantOrderId))}
        </>
      );
    }
    case 'CART_SNAPSHOT': {
      const total = parseMoneyParam(p.total);
      return total ? (
        <p className={styles.detail}>
          <bdi>
            {t('tasks.evidence.phaseC.cartTotal', { total: ltrMoney(total, f.intlLocale) })}
          </bdi>
        </p>
      ) : null;
    }
    case 'HANDOVER': {
      const url = safeExternalUrl(str(p.url));
      return (
        <p className={styles.detail}>
          {t('tasks.evidence.phaseC.handover', { host: String(p.host ?? '—') })}{' '}
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer">
              {t('tasks.phaseC.openSite')}
              <span className="visually-hidden"> {t('tasks.evidence.opensInNewTab')}</span>
            </a>
          )}
        </p>
      );
    }
    // Phase D: phone calls — ids, counts and enums only (what was said is in the call card).
    case 'CALL_PLACED':
      return (
        <>
          <p className={styles.detail}>{t('tasks.evidence.phaseD.placed')}</p>
          {id(t('calls.card.callSid'), str(p.callSid))}
        </>
      );
    case 'CALL_ENDED': {
      const result = CallResult.safeParse(p.result);
      return (
        <p className={styles.detail}>
          {t('tasks.evidence.phaseD.ended', {
            result: result.success ? t(`calls.result.${result.data}`) : String(p.result ?? '—'),
            duration: f.duration(Number(p.seconds ?? 0) * 1000),
          })}
        </p>
      );
    }
    case 'AI_DISCLOSED':
      return (
        <p className={styles.detail}>
          {t('tasks.evidence.phaseD.disclosed', { n: Number(p.sequence ?? 0) + 1 })}
        </p>
      );
    case 'RECORDING_CONSENT':
      return (
        <p className={styles.detail}>
          {t('tasks.evidence.phaseD.consent', { consent: String(p.consent ?? 'not_asked') })}
        </p>
      );
    case 'CALL_TRANSCRIPT':
      return (
        <p className={styles.detail}>
          {t('tasks.evidence.phaseD.transcript', { turns: Number(p.turns ?? 0) })}
        </p>
      );
    case 'CALL_RECORDING':
      return (
        <>
          <p className={styles.detail}>
            {t('tasks.evidence.phaseD.recording', {
              duration: f.duration(Number(p.seconds ?? 0) * 1000),
            })}
          </p>
          {id(t('tasks.fields.sha256'), str(p.sha256))}
        </>
      );
    case 'CALL_TRANSFER':
      return (
        <p className={styles.detail}>
          {t('tasks.evidence.phaseD.transfer', { status: String(p.status ?? '—') })}
        </p>
      );
    case 'DO_NOT_CALL_RECORDED':
      return (
        <p className={styles.detail}>
          <bdi>
            {t('tasks.evidence.phaseD.doNotCall', {
              number: `\u2066${String(p.number ?? '—')}\u2069`,
            })}
          </bdi>
        </p>
      );
  }
}
