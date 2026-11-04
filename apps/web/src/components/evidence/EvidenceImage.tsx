'use client';

import type { EvidenceArtifact } from '@jarvis/contracts';
import { buildPath, routes } from '@jarvis/contracts';
import { Download, ImageOff, Maximize2 } from 'lucide-react';
import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from '@/lib/cx';
import styles from './EvidenceImage.module.css';

/**
 * Where an evidence file is downloaded from (same-origin proxy; owner-only on the server). Only
 * the API's own evidence path is followed, never a URL from content.
 */
export function evidenceHref(
  artifact: Pick<EvidenceArtifact, 'id'> & Partial<Pick<EvidenceArtifact, 'downloadPath'>>,
): string {
  const path = artifact.downloadPath;
  if (path && /^\/v1\/evidence\/[0-9a-f-]{36}\/content$/i.test(path)) return `/api${path}`;
  return `/api${buildPath(routes.downloadEvidence.path, { id: artifact.id })}`;
}

/** The page's host for alt text and captions ("127.0.0.1:4599"), or null. */
export function pageHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * A screenshot the browser agent kept as evidence: a thumbnail that opens a lightbox with the
 * full image, what it shows (alt text: the site and when it was captured) and a download link.
 * A file this server can't read (EVIDENCE_NOT_AVAILABLE) says so instead of a broken image.
 */
export function EvidenceImage({
  artifact,
  caption,
  className,
  size = 'md',
}: {
  artifact: Pick<EvidenceArtifact, 'id'> &
    Partial<Pick<EvidenceArtifact, 'downloadPath' | 'pageUrl' | 'createdAt'>>;
  /** What the screenshot shows, e.g. "Checkout page as JARVIS checked it". */
  caption: string;
  className?: string;
  /** 'sm': a small thumbnail with the caption beside it (lists of evidence). */
  size?: 'md' | 'sm';
}) {
  const { t, f } = useI18n();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const href = evidenceHref(artifact);
  const host = pageHost(artifact.pageUrl);
  const when = artifact.createdAt ? f.dateTime(artifact.createdAt) : null;
  const alt = host
    ? when
      ? t('common.evidence.altHostTime', { host, time: when })
      : t('common.evidence.altHost', { host })
    : t('common.evidence.alt');

  if (failed) {
    return (
      <p className={cx(styles.unavailable, className)}>
        <Icon icon={ImageOff} size={16} />
        {t('common.evidence.unavailable')}
      </p>
    );
  }
  return (
    <figure className={cx(styles.figure, size === 'sm' && styles.small, className)}>
      <button
        type="button"
        className={styles.thumb}
        onClick={() => setOpen(true)}
        aria-label={t('common.evidence.open', { caption })}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- owner-only evidence via the API proxy */}
        <img
          src={href}
          alt={alt}
          loading="lazy"
          decoding="async"
          className={styles.thumbImage}
          onError={() => setFailed(true)}
        />
        <span className={styles.zoom} aria-hidden="true">
          <Icon icon={Maximize2} size={16} />
        </span>
      </button>
      <figcaption className={styles.caption}>
        <span>{caption}</span>
        {host && (
          <span className={styles.captionMeta}>
            <span className="ltr">{host}</span>
            {when && <> · {when}</>}
          </span>
        )}
      </figcaption>
      {open && (
        <Dialog
          open
          size="lg"
          className={styles.wide}
          onClose={() => setOpen(false)}
          title={caption}
          description={alt}
        >
          <div className={styles.lightbox}>
            {/* eslint-disable-next-line @next/next/no-img-element -- owner-only evidence via the API proxy */}
            <img src={href} alt={alt} className={styles.full} />
            <p className={styles.lightboxMeta}>
              {artifact.pageUrl && (
                <span className={cx('ltr', styles.url)} title={artifact.pageUrl}>
                  {artifact.pageUrl}
                </span>
              )}
              <a href={href} download className={styles.download}>
                <Icon icon={Download} size={16} />
                {t('common.evidence.download')}
              </a>
            </p>
          </div>
        </Dialog>
      )}
    </figure>
  );
}
