'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from '@/lib/cx';
import { IconButton } from './Button';
import styles from './Dialog.module.css';

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Keep the title as the accessible name but do not show it. */
  hideTitle?: boolean;
  description?: ReactNode;
  children?: ReactNode;
  /** Actions, end-aligned (primary last). */
  footer?: ReactNode;
  /** Close when the backdrop is clicked (default true). Esc always closes. */
  dismissible?: boolean;
  /** Element to focus on open; defaults to the panel itself so the title is read first. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Busy content (aria-busy on the panel). */
  busy?: boolean;
  className?: string;
  /** Hide the close button (e.g. when the footer has an explicit Cancel). */
  hideClose?: boolean;
}

export interface DialogProps extends OverlayProps {
  size?: 'sm' | 'md' | 'lg';
}

export interface SheetProps extends OverlayProps {
  /** Layout from 640 px up: a centered panel or a full-height side panel on the end side. */
  placement?: 'center' | 'side';
  /** Full-screen on phones (voice mode, forms). Default: bottom sheet. */
  fullScreenOnMobile?: boolean;
}

/**
 * Modal dialog on the native <dialog> element: the rest of the page is inert (focus stays in
 * the dialog), Esc closes, focus returns to the opener, and the title labels it.
 */
export function Dialog({ size = 'md', ...props }: DialogProps) {
  return <Overlay {...props} variantClass={cx(styles.dialog, styles[size])} />;
}

/** Bottom sheet on phones; centered or side panel on larger screens. Same behavior as Dialog. */
export function Sheet({ placement = 'center', fullScreenOnMobile = false, ...props }: SheetProps) {
  return (
    <Overlay
      {...props}
      sheet
      variantClass={cx(
        styles.sheet,
        placement === 'side' ? styles.side : styles.centered,
        fullScreenOnMobile && styles.fullScreenMobile,
      )}
    />
  );
}

function Overlay({
  open,
  onClose,
  title,
  hideTitle,
  description,
  children,
  footer,
  dismissible = true,
  initialFocusRef,
  busy,
  className,
  hideClose,
  sheet = false,
  variantClass,
}: OverlayProps & { sheet?: boolean; variantClass: string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const pointerDownOnBackdrop = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      el.showModal();
      (initialFocusRef?.current ?? panelRef.current)?.focus({ preventScroll: true });
    } else if (!open && el.open) {
      el.close();
      const target = returnFocus.current;
      if (target && target.isConnected) target.focus({ preventScroll: true });
    }
  }, [open, initialFocusRef]);

  // Close (and restore focus) if unmounted while open.
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el?.open) el.close();
      const target = returnFocus.current;
      if (target && target.isConnected) target.focus({ preventScroll: true });
    };
  }, []);

  return (
    // Backdrop clicks close as a convenience; Esc (the cancel event) is the keyboard equivalent.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={ref}
      className={cx(styles.overlay, variantClass, className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        // Esc: let React state decide (keeps open/close controlled).
        e.preventDefault();
        onCloseRef.current();
      }}
      onPointerDown={(e) => {
        pointerDownOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (dismissible && pointerDownOnBackdrop.current && e.target === e.currentTarget) {
          onCloseRef.current();
        }
        pointerDownOnBackdrop.current = false;
      }}
    >
      {open && (
        <div ref={panelRef} className={styles.panel} tabIndex={-1} aria-busy={busy || undefined}>
          {sheet && <div className={styles.handle} aria-hidden="true" />}
          <header className={cx(styles.header, hideTitle && styles.headerBare)}>
            <div className={cx(styles.headerText, hideTitle && 'visually-hidden')}>
              <h2 id={titleId} className={styles.title}>
                {title}
              </h2>
              {description && (
                <p id={descId} className={styles.description}>
                  {description}
                </p>
              )}
            </div>
            {!hideClose && (
              <IconButton
                label={t('common.actions.close')}
                icon={X}
                size="sm"
                tooltip="none"
                onClick={() => onCloseRef.current()}
                className={styles.close}
              />
            )}
          </header>
          <div className={styles.body}>{children}</div>
          {footer && <footer className={styles.footer}>{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
