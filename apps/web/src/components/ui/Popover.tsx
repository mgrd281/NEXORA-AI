'use client';

import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { cx } from '@/lib/cx';
import styles from './Popover.module.css';

export type PopoverPlacement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end' | 'end';

/**
 * Non-modal floating panel anchored to its trigger (place both inside a PopoverAnchor).
 * Esc or a click outside closes it and returns focus to the trigger; focus moves into it.
 */
export function Popover({
  open,
  onClose,
  triggerRef,
  label,
  placement = 'bottom-end',
  role = 'dialog',
  children,
  className,
  width = 320,
  initialFocus = 'panel',
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  label: string;
  placement?: PopoverPlacement;
  role?: 'dialog' | 'menu';
  children: ReactNode;
  className?: string;
  width?: number;
  /** 'first' focuses the first focusable child (menus), 'panel' the panel itself. */
  initialFocus?: 'panel' | 'first';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const panel = ref.current;
    if (initialFocus === 'first') {
      panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    } else {
      panel?.focus();
    }
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (panel?.contains(target) || triggerRef.current?.contains(target)) return;
      onCloseRef.current();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, triggerRef, initialFocus]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      role={role}
      aria-label={label}
      tabIndex={-1}
      className={cx(styles.popover, styles[placement], className)}
      style={{ inlineSize: `min(${width}px, calc(100vw - 2 * var(--space-4)))` }}
      onKeyDown={role === 'menu' ? onMenuKeyDown : undefined}
      onBlur={(e) => {
        // Tabbing out of a non-modal popover closes it.
        const next = e.relatedTarget as Node | null;
        if (next && !ref.current?.contains(next) && !triggerRef.current?.contains(next)) {
          onCloseRef.current();
        }
      }}
    >
      {children}
    </div>
  );
}

/** Positioning context for a trigger and its Popover. */
export function PopoverAnchor({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx(styles.anchor, className)}>{children}</div>;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Arrow keys, Home and End move between menu items (role="menuitem"). */
function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
  const items = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'),
  );
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  let next = -1;
  if (e.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length;
  else if (e.key === 'ArrowUp') next = index <= 0 ? items.length - 1 : index - 1;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  if (next >= 0) {
    e.preventDefault();
    items[next]?.focus();
  }
}
