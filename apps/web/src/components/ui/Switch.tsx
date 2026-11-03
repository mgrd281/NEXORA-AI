'use client';

import { useId, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Switch.module.css';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  /** Shows a busy state while a change is being saved. */
  busy?: boolean;
  className?: string;
  id?: string;
}

/**
 * On/off setting (role="switch"). The whole row is the label; the thumb sits on the end side
 * when on, which mirrors in RTL.
 */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  busy,
  className,
  id: idProp,
}: SwitchProps) {
  const autoId = useId();
  const id = idProp ?? `sw${autoId}`;
  const labelId = `${id}-label`;
  const descId = description ? `${id}-desc` : undefined;
  return (
    <div className={cx(styles.row, disabled && styles.disabled, className)}>
      <div className={styles.text}>
        <label id={labelId} htmlFor={id} className={styles.label}>
          {label}
        </label>
        {description && (
          <p id={descId} className={styles.description}>
            {description}
          </p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descId}
        aria-busy={busy || undefined}
        disabled={disabled}
        className={styles.switch}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.thumb} aria-hidden="true" />
      </button>
    </div>
  );
}
