'use client';

import type { Evidence } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import {
  BookmarkPlus,
  Bot,
  CalendarClock,
  Database,
  ExternalLink,
  FileSearch,
  FileText,
  Fingerprint,
  Globe,
  History,
  MailCheck,
  MessageCircleQuestionMark,
  Scissors,
  StickyNote,
} from 'lucide-react';
import Link from 'next/link';
import { CopyButton } from '@/components/ui/CopyButton';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import type { MessageKey } from '@/i18n/catalog';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from '@/lib/cx';
import styles from './Evidence.module.css';
import { parseEvidence, shortHash, type EvidenceView } from './model';
import { ExactTime, useByteFormat } from './format';

const ICON: Record<Evidence['kind'], LucideIcon> = {
  smtp_receipt: MailCheck,
  http_response: Globe,
  content_hash: Fingerprint,
  record: Database,
  model_output: Bot,
  note: StickyNote,
};

/** A failure code (HTTP 4xx/5xx, SMTP 4xx/5xx) is the one technical detail that needs colour. */
const failed = (code: number | string | null) => code !== null && Number(String(code)[0]) >= 4;

/** URL without the scheme, for display (the link keeps the full URL). */
function displayUrl(href: string): string {
  return href.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/**
 * Evidence rendered by what it proves, in plain language first ("Page read", "Mail server
 * accepted it"), with the protocol details as secondary mono text: the fetched page as an
 * external link with its HTTP status, a content fingerprint, the SMTP reply and Message-ID.
 */
export function EvidenceList({
  items,
  compact = false,
  className,
}: {
  items: readonly Evidence[];
  compact?: boolean;
  className?: string;
}) {
  return (
    <ul className={cx(styles.list, compact && styles.compact, className)}>
      {items.map((item, i) => (
        <EvidenceItem key={`${item.kind}-${item.at}-${i}`} evidence={item} />
      ))}
    </ul>
  );
}

/** The headline of a piece of evidence: what it proves, in the interface language. */
function evidenceTitle(view: EvidenceView, kind: Evidence['kind']): MessageKey {
  switch (view.kind) {
    case 'extractive':
      return 'tasks.evidence.extractive';
    case 'memory_record':
      return 'tasks.evidence.memoryRecord';
    case 'truncated':
      return 'tasks.evidence.truncated';
    case 'document':
      return 'tasks.evidence.document';
    case 'schedule':
      return 'tasks.evidence.schedule';
    case 'recalled':
      return 'tasks.evidence.recalled';
    case 'question':
      return 'tasks.evidence.question';
    default:
      return `tasks.evidence.${kind}`;
  }
}

const VIEW_ICON: Partial<Record<EvidenceView['kind'], LucideIcon>> = {
  extractive: FileText,
  memory_record: BookmarkPlus,
  truncated: Scissors,
  document: FileSearch,
  schedule: CalendarClock,
  recalled: History,
  question: MessageCircleQuestionMark,
};

function EvidenceItem({ evidence }: { evidence: Evidence }) {
  const { t } = useI18n();
  const view = parseEvidence(evidence);
  return (
    <li className={styles.item}>
      <span className={styles.icon}>
        <Icon icon={VIEW_ICON[view.kind] ?? ICON[evidence.kind]} size={16} />
      </span>
      <div className={styles.body}>
        <div className={styles.head}>
          <p className={styles.title}>{t(evidenceTitle(view, evidence.kind))}</p>
          <ExactTime value={evidence.at} timeOnly className={styles.at} />
        </div>
        <EvidenceBody view={view} />
      </div>
    </li>
  );
}

function EvidenceBody({ view }: { view: EvidenceView }) {
  const { t, f } = useI18n();
  const bytes = useByteFormat();
  switch (view.kind) {
    case 'smtp_receipt':
      return (
        <>
          {(view.code || view.response) && (
            // The line aligns with the interface; the protocol text inside stays left-to-right.
            <p className={cx(styles.code, failed(view.code) && styles.codeFailed)}>
              <span className="ltr">
                {[view.code && `SMTP ${view.code}`, view.response].filter(Boolean).join(' · ')}
              </span>
            </p>
          )}
          {view.messageId && (
            <div className={styles.valueRow}>
              <span className={styles.valueLabel}>{t('tasks.evidence.messageId')}</span>
              <code className={cx(styles.value, 'ltr')}>{view.messageId}</code>
              <CopyButton value={view.messageId} label={t('tasks.evidence.messageId')} />
            </div>
          )}
        </>
      );
    case 'http_response':
      return (
        <>
          {/* "HTTP 200 · text/html · 5 kB": protocol parts left-to-right, the size in the
              interface language (its own isolate, so "5 كيلوبايت" reads correctly). */}
          {(view.status !== null || view.contentType || view.bytes !== null) && (
            <p className={cx(styles.code, failed(view.status) && styles.codeFailed)}>
              <span className="ltr">
                {[view.status !== null && `HTTP ${view.status}`, view.contentType]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {view.bytes !== null && (
                <>
                  {(view.status !== null || view.contentType) && (
                    <span aria-hidden="true"> · </span>
                  )}
                  <bdi className="tabular">{bytes(view.bytes)}</bdi>
                </>
              )}
            </p>
          )}
          {view.url && (
            <div className={styles.valueRow}>
              <a
                href={view.url}
                target="_blank"
                rel="noopener noreferrer"
                className={cx(styles.link, 'ltr')}
                title={view.url}
              >
                <span className={styles.linkText}>{displayUrl(view.url)}</span>
                <Icon icon={ExternalLink} size={16} className={styles.linkIcon} />
                <span className="visually-hidden"> {t('tasks.evidence.opensInNewTab')}</span>
              </a>
            </div>
          )}
        </>
      );
    case 'content_hash':
      return (
        <div className={styles.valueRow}>
          {view.algorithm && <span className={styles.valueLabel}>{view.algorithm}</span>}
          <code className={cx(styles.value, 'ltr')} title={view.value}>
            {shortHash(view.hex, 12, 8)}
          </code>
          <CopyButton value={view.value} label={t('tasks.evidence.copyHash')} />
        </div>
      );
    case 'model_output':
      return (
        <div className={styles.facts}>
          <code className={cx(styles.value, 'ltr')}>{view.model}</code>
          {view.inputTokens !== null && view.outputTokens !== null && (
            <span className={styles.detail}>
              {t('tasks.evidence.tokens', {
                input: f.number(view.inputTokens),
                output: f.number(view.outputTokens),
              })}
            </span>
          )}
        </div>
      );
    case 'extractive':
      return (
        <>
          <p className={styles.detail}>
            {t('tasks.evidence.extractiveDetail', { sentences: view.sentences, chars: view.chars })}
          </p>
          {view.excluded !== null && view.excluded > 0 && (
            <p className={styles.detail}>
              {t('tasks.evidence.excluded', { count: view.excluded })}
            </p>
          )}
        </>
      );
    case 'memory_record':
      return (
        <div className={styles.valueRow}>
          <span className={styles.valueLabel}>
            {view.memoryKind ? t(`memory.kinds.${view.memoryKind}`) : t('tasks.evidence.memoryId')}
          </span>
          <code className={cx(styles.value, 'ltr')} title={view.memoryId}>
            {shortHash(view.memoryId, 8, 4)}
          </code>
          <CopyButton value={view.memoryId} label={t('tasks.evidence.copyMemoryId')} />
        </div>
      );
    case 'truncated':
      return <p className={styles.detail}>{t('tasks.evidence.truncatedDetail')}</p>;
    case 'document':
      return (
        <>
          {view.pages !== null && view.chars !== null && (
            <p className={styles.detail}>
              {t('tasks.evidence.documentDetail', { pages: view.pages, chars: view.chars })}
            </p>
          )}
          {view.truncated && (
            <p className={styles.detail}>{t('tasks.evidence.documentTruncated')}</p>
          )}
        </>
      );
    case 'schedule':
      return view.nextRunAt ? (
        <p className={styles.detail}>
          <RelativeTime
            value={view.nextRunAt}
            format={(time) => t('tasks.evidence.scheduleNext', { time })}
          />
        </p>
      ) : null;
    case 'recalled':
      return (
        <p className={styles.detail}>
          <Link href={`/tasks/${view.taskId}`}>{t('tasks.evidence.recalledLink')}</Link>
        </p>
      );
    case 'question':
      return view.missing.length > 0 ? (
        <p className={styles.detail}>
          {t('tasks.evidence.questionMissing', {
            list: f.list(view.missing.map((m) => t(`conversations.question.missing.${m}`))),
          })}
        </p>
      ) : null;
    case 'record':
    case 'note':
      return (
        <p className={styles.detail}>
          <bdi className={styles.noteLabel}>{view.label}</bdi>
          {view.value && (
            <>
              <span aria-hidden="true"> · </span>
              <bdi>{view.value}</bdi>
            </>
          )}
        </p>
      );
  }
}
