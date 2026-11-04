'use client';

import type { Attachment } from '@jarvis/contracts';
import { ATTACHMENT_LIMITS } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import {
  CircleAlert,
  Download,
  FileSpreadsheet,
  FileText,
  FileType,
  Paperclip,
  RotateCw,
  X,
} from 'lucide-react';
import { forwardRef, useId, useImperativeHandle, useRef, type ChangeEvent } from 'react';
import { Button, IconButton } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useByteFormat } from '@/features/tasks/format';
import { useI18n } from '@/i18n/I18nProvider';
import { describeError } from '@/lib/api/errors';
import { cx } from '@/lib/cx';
import styles from './Attachments.module.css';
import {
  ACCEPT_ATTRIBUTE,
  downloadUrl,
  fileKind,
  LIMIT_MB,
  mediaTypeFor,
  type FileKind,
} from './files';
import type { AttachmentDraft, DraftItem } from './useAttachmentDraft';

const KIND_ICON: Record<FileKind, LucideIcon> = {
  pdf: FileType,
  docx: FileText,
  txt: FileText,
  md: FileText,
  csv: FileSpreadsheet,
};

export interface AttachButtonHandle {
  open: () => void;
}

/**
 * The paperclip: opens the system file picker (several files at once). `prominent` shows it as
 * a labelled button (e.g. when JARVIS asked for a document) instead of an icon.
 */
export const AttachButton = forwardRef<
  AttachButtonHandle,
  {
    onFiles: (files: File[]) => void;
    disabled?: boolean;
    prominent?: boolean;
    label?: string;
    className?: string;
  }
>(function AttachButton({ onFiles, disabled, prominent, label, className }, ref) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  useImperativeHandle(ref, () => ({ open: () => inputRef.current?.click() }), []);
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? [...e.target.files] : [];
    // Reset so choosing the same file again (after removing it) fires a change.
    e.target.value = '';
    if (files.length > 0) onFiles(files);
  };
  const name = label ?? t('attachments.attach');
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onChange}
      />
      <span id={hintId} className="visually-hidden">
        {t('attachments.accepts', { limitMb: LIMIT_MB })}
      </span>
      {prominent ? (
        <Button
          size="sm"
          icon={Paperclip}
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          aria-describedby={hintId}
          className={className}
        >
          {name}
        </Button>
      ) : (
        <IconButton
          label={name}
          icon={Paperclip}
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          aria-describedby={hintId}
          className={className}
        />
      )}
    </>
  );
});

/** The files staged in a composer: progress, readiness or why one wasn't attached. */
export function AttachmentTray({ draft }: { draft: AttachmentDraft }) {
  const { t } = useI18n();
  return (
    <>
      {draft.items.length > 0 && (
        // eslint-disable-next-line jsx-a11y/no-redundant-roles -- list-style: none drops it in Safari
        <ul className={styles.tray} role="list" aria-label={t('attachments.listLabel')}>
          {draft.items.map((item) => (
            <DraftChip key={item.key} item={item} draft={draft} />
          ))}
        </ul>
      )}
      {draft.overflow && (
        <p className={styles.trayNote} role="alert">
          {t('errors.api.TOO_MANY_ATTACHMENTS', { max: ATTACHMENT_LIMITS.maxPerRequest })}
        </p>
      )}
    </>
  );
}

/** Says what happened to the staged files (attached, removed, not attached). Always mounted. */
export function AttachmentAnnouncer({ draft }: { draft: AttachmentDraft }) {
  const { t } = useI18n();
  const announcement = draft.announcement;
  return (
    <span className="visually-hidden" role="status" aria-live="polite">
      {announcement
        ? announcement.kind === 'added'
          ? t('attachments.added', { name: announcement.name })
          : announcement.kind === 'removed'
            ? t('attachments.removed', { name: announcement.name })
            : `${announcement.name}: ${t('attachments.failed')}`
        : ''}
    </span>
  );
}

function DraftChip({ item, draft }: { item: DraftItem; draft: AttachmentDraft }) {
  const i18n = useI18n();
  const { t, f } = i18n;
  const bytes = useByteFormat();
  const kind = fileKind(item.attachment?.mediaType ?? mediaTypeFor(item.name));
  const percent = Math.round(item.progress * 100);
  const error = item.status === 'error' ? describeError(item.error, i18n).message : null;
  return (
    <li
      className={cx(styles.chip, item.status === 'error' && styles.chipError)}
      data-status={item.status}
    >
      <span className={styles.chipIcon}>
        <Icon
          icon={item.status === 'error' ? CircleAlert : kind ? KIND_ICON[kind] : FileText}
          size={16}
        />
      </span>
      <span className={styles.chipText}>
        <span className={styles.chipName} dir="auto" title={item.name}>
          {item.name}
        </span>
        <span className={styles.chipMeta}>
          {item.status === 'uploading' ? (
            <span className="tabular">
              {t('attachments.uploadingProgress', { percent: f.number(percent) })}
            </span>
          ) : item.status === 'error' ? (
            <span className={styles.chipErrorText}>{error}</span>
          ) : (
            t('attachments.meta', {
              type: kind ? t(`attachments.types.${kind}`) : '—',
              size: bytes(item.size),
            })
          )}
        </span>
      </span>
      {item.status === 'error' && !item.final && (
        <IconButton
          size="sm"
          icon={RotateCw}
          label={t('attachments.retry', { name: item.name })}
          onClick={() => draft.retry(item.key)}
          className={styles.chipButton}
        />
      )}
      <IconButton
        size="sm"
        icon={X}
        label={t('attachments.remove', { name: item.name })}
        onClick={() => draft.remove(item.key)}
        className={styles.chipButton}
      />
      {item.status === 'uploading' && (
        <span className={styles.progress} aria-hidden="true">
          <span className={styles.progressBar} style={{ inlineSize: `${Math.max(4, percent)}%` }} />
        </span>
      )}
    </li>
  );
}

/**
 * Files attached to a request, each a download link (the API serves it to its owner only).
 * `compact` drops the size line (thread turns); the full list says who can download them.
 */
export function AttachmentList({
  attachments,
  compact = false,
  className,
}: {
  attachments: readonly Attachment[];
  compact?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const bytes = useByteFormat();
  if (attachments.length === 0) return null;
  const list = (
    // eslint-disable-next-line jsx-a11y/no-redundant-roles -- list-style: none drops it in Safari
    <ul className={cx(styles.list, className)} role="list" aria-label={t('attachments.filesLabel')}>
      {attachments.map((a) => {
        const kind = fileKind(a.mediaType);
        return (
          <li key={a.id}>
            <a
              className={cx(styles.file, compact && styles.fileCompact)}
              href={downloadUrl(a.id)}
              download={a.filename}
            >
              <span className={styles.chipIcon}>
                <Icon icon={kind ? KIND_ICON[kind] : FileText} size={16} />
              </span>
              <span className={styles.chipText}>
                <span className={styles.chipName} dir="auto">
                  {a.filename}
                </span>
                {!compact && (
                  <span className={styles.chipMeta}>
                    {t('attachments.meta', {
                      type: kind ? t(`attachments.types.${kind}`) : '—',
                      size: bytes(a.sizeBytes),
                    })}
                    {a.pageCount !== null && a.mediaType === 'application/pdf' && (
                      <> · {t('attachments.pages', { count: a.pageCount })}</>
                    )}
                  </span>
                )}
              </span>
              <span className={styles.downloadIcon}>
                <Icon icon={Download} size={16} />
                <span className="visually-hidden"> {t('attachments.downloadHint')}</span>
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
  if (compact) return list;
  return (
    <div className={styles.listBlock}>
      {list}
      <p className={styles.ownerNote}>{t('attachments.ownerOnly')}</p>
    </div>
  );
}
