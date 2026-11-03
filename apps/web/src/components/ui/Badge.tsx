import type { RiskLevel } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import { Shield, ShieldAlert, ShieldX } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Badge.module.css';
import { Icon } from './Icon';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

/** Small label chip. Tone is never the only signal: pair it with text (and an icon). */
export function Badge({
  tone = 'neutral',
  icon,
  children,
  className,
  title,
}: {
  tone?: Tone;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span className={cx(styles.badge, styles[tone], className)} title={title}>
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
}: {
  tone: Tone;
  icon: LucideIcon;
  label: string;
  className?: string;
}) {
  return (
    <Badge tone={tone} icon={icon} className={cx(styles.pill, className)}>
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
export function RiskBadge({ level, label }: { level: RiskLevel; label: string }) {
  return <StatusPill tone={RISK_TONE[level]} icon={RISK_ICON[level]} label={label} />;
}
