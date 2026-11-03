import type { RiskLevel } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import { Shield, ShieldAlert, ShieldX } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Badge.module.css';
import { Icon } from './Icon';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

/**
 * Small label chip. Tone is never the only signal: pair it with text (and an icon).
 * `outline` (a tinted hairline instead of a fill) is for badges on tinted containers.
 */
export function Badge({
  tone = 'neutral',
  variant = 'soft',
  icon,
  children,
  className,
  title,
}: {
  tone?: Tone;
  variant?: 'soft' | 'outline';
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={cx(styles.badge, styles[tone], variant === 'outline' && styles.outline, className)}
      title={title}
    >
      {icon && <Icon icon={icon} size={16} className={styles.icon} />}
      <span className={styles.text}>{children}</span>
    </span>
  );
}

/** Status chip: icon + label + tone, e.g. for task and step states. */
export function StatusPill({
  tone,
  icon,
  label,
  className,
  variant,
}: {
  tone: Tone;
  icon: LucideIcon;
  label: string;
  className?: string;
  variant?: 'soft' | 'outline';
}) {
  return (
    <Badge tone={tone} icon={icon} variant={variant} className={cx(styles.pill, className)}>
      {label}
    </Badge>
  );
}

const RISK_TONE: Record<RiskLevel, Tone> = {
  LOW: 'neutral',
  MEDIUM: 'warning',
  HIGH: 'danger',
  CRITICAL: 'danger',
};
const RISK_ICON: Record<RiskLevel, LucideIcon> = {
  LOW: Shield,
  MEDIUM: ShieldAlert,
  HIGH: ShieldAlert,
  CRITICAL: ShieldX,
};

/** Risk level from the policy engine, always with its text label. */
export function RiskBadge({
  level,
  label,
  variant,
}: {
  level: RiskLevel;
  label: string;
  variant?: 'soft' | 'outline';
}) {
  return (
    <StatusPill tone={RISK_TONE[level]} icon={RISK_ICON[level]} label={label} variant={variant} />
  );
}
