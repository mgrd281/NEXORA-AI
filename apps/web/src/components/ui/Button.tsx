'use client';

import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { cx } from '@/lib/cx';
import styles from './Button.module.css';
import { Icon, type IconSize } from './Icon';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

const ICON_SIZE: Record<ButtonSize, IconSize> = { sm: 16, md: 16, lg: 20 };

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (decorative). */
  icon?: LucideIcon;
  /** Trailing icon (decorative), e.g. a chevron. */
  iconEnd?: LucideIcon;
  /** Mirror the icons in RTL (arrows, chevrons). */
  mirrorIcons?: boolean;
  fullWidth?: boolean;
}

export interface ButtonProps extends CommonProps, ButtonHTMLAttributes<HTMLButtonElement> {
  /** Shows a spinner, sets aria-busy and ignores clicks while true. */
  loading?: boolean;
}

/**
 * Buttons: primary (ink), secondary (outlined), ghost, danger (tinted) and destructive (solid,
 * for the confirmation step of irreversible actions). Sizes 32 / 40 / 48 px; on coarse pointers
 * the hit area grows to 44 px without changing the layout.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    iconEnd,
    mirrorIcons,
    fullWidth,
    loading = false,
    disabled,
    className,
    children,
    type = 'button',
    onClick,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        styles.button,
        styles[variant],
        styles[size],
        fullWidth && styles.fullWidth,
        loading && styles.loading,
        className,
      )}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={(e) => {
        if (loading) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...rest}
    >
      {loading ? (
        <Spinner size={ICON_SIZE[size] === 20 ? 20 : 16} />
      ) : icon ? (
        <Icon icon={icon} size={ICON_SIZE[size]} mirror={mirrorIcons} />
      ) : null}
      {children !== undefined && children !== null && (
        <span className={styles.text}>{children}</span>
      )}
      {iconEnd && !loading && <Icon icon={iconEnd} size={ICON_SIZE[size]} mirror={mirrorIcons} />}
    </button>
  );
});

export interface ButtonLinkProps
  extends CommonProps, Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string;
  children: ReactNode;
}

/** A link that looks like a button (navigation, not an action). */
export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  icon,
  iconEnd,
  mirrorIcons,
  fullWidth,
  className,
  children,
  href,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link
      href={href}
      className={cx(
        styles.button,
        styles[variant],
        styles[size],
        styles.link,
        fullWidth && styles.fullWidth,
        className,
      )}
      {...rest}
    >
      {icon && <Icon icon={icon} size={ICON_SIZE[size]} mirror={mirrorIcons} />}
      <span className={styles.text}>{children}</span>
      {iconEnd && <Icon icon={iconEnd} size={ICON_SIZE[size]} mirror={mirrorIcons} />}
    </Link>
  );
}

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'children'
> {
  /** Accessible name; also shown as the tooltip. Required. */
  label: string;
  icon: LucideIcon;
  variant?: 'ghost' | 'primary' | 'secondary';
  size?: ButtonSize;
  mirror?: boolean;
  loading?: boolean;
  /** Where the tooltip appears. 'none' hides it (e.g. when a visible label is adjacent). */
  tooltip?: 'top' | 'bottom' | 'none';
  /** Small count or dot shown on the button's corner (e.g. unread notifications). */
  badge?: ReactNode;
  shape?: 'square' | 'round';
}

const ICON_BUTTON_ICON: Record<ButtonSize, IconSize> = { sm: 16, md: 20, lg: 24 };

/** Icon-only button. Always named (`label`), with a tooltip on hover and keyboard focus. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    variant = 'ghost',
    size = 'md',
    mirror,
    loading = false,
    tooltip = 'top',
    badge,
    shape = 'square',
    className,
    disabled,
    type = 'button',
    onClick,
    onKeyDown,
    onFocus,
    onBlur,
    onPointerEnter,
    onPointerLeave,
    ...rest
  },
  ref,
) {
  const [tipOpen, setTipOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const tipId = useId();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const showTip = (delay: number) => {
    if (tooltip === 'none') return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setTipOpen(true), delay);
  };
  const hideTip = () => {
    window.clearTimeout(timer.current);
    setTipOpen(false);
  };

  return (
    <span className={cx(styles.iconButtonWrap, className)}>
      <button
        ref={ref}
        type={type}
        className={cx(
          styles.button,
          styles.iconButton,
          styles[variant],
          styles[size],
          shape === 'round' && styles.round,
          loading && styles.loading,
        )}
        disabled={disabled}
        aria-busy={loading || undefined}
        onClick={(e) => {
          hideTip();
          if (loading) return;
          onClick?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') hideTip();
          onKeyDown?.(e);
        }}
        onFocus={(e) => {
          if (e.currentTarget.matches(':focus-visible')) showTip(0);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          hideTip();
          onBlur?.(e);
        }}
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') showTip(450);
          onPointerEnter?.(e);
        }}
        onPointerLeave={(e) => {
          hideTip();
          onPointerLeave?.(e);
        }}
        {...rest}
      >
        {loading ? (
          <Spinner size={ICON_BUTTON_ICON[size]} />
        ) : (
          <Icon icon={icon} size={ICON_BUTTON_ICON[size]} mirror={mirror} />
        )}
        {/* The name is real (hidden) text, not aria-label, so a visible badge never conflicts. */}
        <span className="visually-hidden">{label}</span>
        {badge !== undefined && badge !== null && badge !== false && (
          <span className={cx(styles.badge, 'tabular')} aria-hidden="true">
            {badge}
          </span>
        )}
      </button>
      {tooltip !== 'none' && (
        <span
          id={tipId}
          aria-hidden="true"
          className={cx(styles.tooltip, tooltip === 'bottom' && styles.tooltipBottom)}
          data-open={tipOpen || undefined}
        >
          {label}
        </span>
      )}
    </span>
  );
});
