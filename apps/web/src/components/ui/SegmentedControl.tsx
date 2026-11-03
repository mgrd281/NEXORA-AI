'use client';

import type { LucideIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';
import styles from './SegmentedControl.module.css';

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string> {
  /** Group name (the legend); visually hidden unless showLegend. */
  legend: ReactNode;
  showLegend?: boolean;
  options: readonly SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  className?: string;
  name?: string;
}

/**
 * A small set of mutually exclusive choices. Built on native radio inputs, so arrow keys,
 * RTL order and screen-reader semantics (radio group) come from the platform.
 */
export function SegmentedControl<V extends string>({
  legend,
  showLegend = false,
  options,
  value,
  onChange,
  size = 'md',
  fullWidth,
  className,
  name: nameProp,
}: SegmentedControlProps<V>) {
  const autoName = useId();
  const name = nameProp ?? `seg${autoName}`;
  return (
    <fieldset className={cx(styles.fieldset, className)}>
      <legend className={showLegend ? styles.legend : 'visually-hidden'}>{legend}</legend>
      <div className={cx(styles.track, styles[size], fullWidth && styles.fullWidth)}>
        {options.map((o) => (
          <label
            key={o.value}
            className={cx(styles.option, o.disabled && styles.disabled)}
            data-checked={o.value === value || undefined}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={o.value === value}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
              className={styles.input}
            />
            {o.icon && <Icon icon={o.icon} size={16} />}
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
