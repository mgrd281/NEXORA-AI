'use client';

import type { Evidence } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  Database,
  ExternalLink,
  Fingerprint,
  Globe,
  MailCheck,
  StickyNote,
} from 'lucide-react';
import { Badge, type Tone } from '@/components/ui/Badge';
import { CopyButton } from '@/components/ui/CopyButton';
import { Icon } from '@/components/ui/Icon';
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

function httpTone(status: number | null): Tone {
  if (status === null) return 'neutral';
  if (status < 300) return 'success';
  if (status < 400) return 'accent';
  return 'danger';
}

/** URL without the scheme, for display (the link keeps the full URL). */
function displayUrl(href: string): string {
  return href.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/**
 * Evidence rendered by what it proves: an SMTP receipt with its Message-ID, the fetched page as
 * an external link with its HTTP status, a content fingerprint, the model that answered.
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

function EvidenceItem({ evidence }: { evidence: Evidence }) {
  const { t } = useI18n();
  const view = parseEvidence(evidence);
  return (
    <li className={styles.item}>
      <span className={styles.icon}>
        <Icon icon={ICON[evidence.kind]} size={16} />
      </span>
      <div className={styles.body}>
        <div className={styles.head}>
          <p className={styles.title}>{t(`tasks.evidence.${evidence.kind}`)}</p>
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
          <div className={styles.facts}>
            {view.code && (
              <Badge tone={view.code.startsWith('2') ? 'success' : 'danger'}>
                <span className="ltr">SMTP {view.code}</span>
              </Badge>
            )}
            {view.response && (
              <span className={cx(styles.detail, styles.mono, 'ltr')}>{view.response}</span>
            )}
          </div>
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
          <div className={styles.facts}>
            {view.status !== null && (
              <Badge tone={httpTone(view.status)}>
                <span className="ltr">HTTP {view.status}</span>
              </Badge>
            )}
            {/* Separate isolated pieces so the order survives right-to-left layout. */}
            {view.contentType && (
              <span className={cx(styles.detail, 'ltr')}>{view.contentType}</span>
            )}
            {view.contentType && view.bytes !== null && (
              <span className={styles.sep} aria-hidden="true">
                ·
              </span>
            )}
            {view.bytes !== null && (
              <span className={cx(styles.detail, 'tabular')}>
                <bdi>{bytes(view.bytes)}</bdi>
              </span>
            )}
          </div>
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
    case 'record':
    case 'note':
      return (
        <p className={styles.detail}>
          <span className={styles.noteLabel} dir="auto">
            {view.label}
          </span>
          {view.value && (
            <>
              <span aria-hidden="true"> · </span>
              <span dir="auto">{view.value}</span>
            </>
          )}
        </p>
      );
  }
}
