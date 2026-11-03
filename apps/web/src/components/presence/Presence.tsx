'use client';

import type { CSSProperties } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from '@/lib/cx';
import type { PresenceDescriptor, PresenceProgress, PresenceState } from './model';
import styles from './Presence.module.css';

export type PresenceSize = 16 | 24 | 40 | 96;

/** Stroke width in viewBox units (viewBox is 48 × 48) per rendered size. */
const STROKE: Record<PresenceSize, number> = { 16: 4.5, 24: 3.5, 40: 2.6, 96: 1.5 };
const C = 24;

export interface PresenceProps {
  state: PresenceState;
  size?: PresenceSize;
  /** Step progress for `running`. */
  progress?: PresenceProgress;
  /** Live microphone level 0…1 for `listening`. */
  level?: number;
  /** Status text. Defaults to the state's generic label. */
  label?: string;
  /** Show the label next to the ring; otherwise it is visually hidden but announced. */
  showLabel?: boolean;
  /** Announce label changes politely (use once per screen, e.g. the shell's Presence). */
  live?: boolean;
  className?: string;
  labelClassName?: string;
}

const DEFAULT_LABEL: Record<PresenceState, PresenceDescriptor['labelKey']> = {
  idle: 'common.presence.idle',
  listening: 'common.presence.listening',
  thinking: 'common.presence.thinking',
  running: 'common.presence.running',
  awaiting: 'common.presence.awaiting',
  completed: 'common.presence.completed',
  failed: 'common.presence.failed',
  reconnecting: 'common.presence.reconnecting',
  offline: 'common.presence.offline',
};

/**
 * The Presence indicator: a small precise ring that shows what JARVIS is really doing. The
 * graphic is aria-hidden and always paired with a text label. With reduced motion nothing
 * rotates or scales; the static arc and the label carry the state.
 */
export function Presence({
  state,
  size = 24,
  progress,
  level = 0,
  label,
  showLabel = false,
  live = false,
  className,
  labelClassName,
}: PresenceProps) {
  const { t } = useI18n();
  const text = label ?? t(DEFAULT_LABEL[state]);
  const sw = STROKE[size];
  const r = C - 4 - sw / 2;
  const fraction =
    progress && progress.total > 0
      ? Math.min(1, Math.max(0, progress.completed / progress.total))
      : 0;
  const style = {
    '--presence-sw': `${sw}px`,
    '--presence-level': String(Math.min(1, Math.max(0, level))),
  } as CSSProperties;

  return (
    <span
      className={cx(styles.root, className)}
      data-state={state}
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
    >
      <svg
        className={cx(styles.svg, styles[state])}
        width={size}
        height={size}
        viewBox="0 0 48 48"
        aria-hidden="true"
        focusable="false"
        style={style}
        data-size={size}
      >
        <Ring state={state} r={r} sw={sw} fraction={fraction} size={size} />
      </svg>
      <span className={showLabel ? cx(styles.label, labelClassName) : 'visually-hidden'}>
        {text}
      </span>
    </span>
  );
}

function Ring({
  state,
  r,
  sw,
  fraction,
  size,
}: {
  state: PresenceState;
  r: number;
  sw: number;
  fraction: number;
  size: PresenceSize;
}) {
  const common = { cx: C, cy: C, r, fill: 'none', pathLength: 100 } as const;
  switch (state) {
    case 'idle':
      return (
        <>
          <circle {...common} className={styles.idleRing} strokeWidth={sw * 0.7} />
          <circle cx={C} cy={C} r={sw * (size >= 40 ? 1.1 : 0.85)} className={styles.idleCore} />
        </>
      );
    case 'listening':
      return (
        <>
          <circle cx={C} cy={C} r={r} className={styles.listenHalo} />
          <circle {...common} className={styles.listenRing} />
        </>
      );
    case 'thinking':
      return (
        <>
          <circle {...common} className={styles.track} strokeWidth={sw} />
          <g className={styles.spin}>
            <circle
              {...common}
              className={styles.arc}
              strokeWidth={sw}
              strokeDasharray="26 74"
              transform={`rotate(-90 ${C} ${C})`}
            />
          </g>
        </>
      );
    case 'running': {
      const pct = Math.max(fraction * 100, 3);
      return (
        <>
          <circle {...common} className={styles.track} strokeWidth={sw} />
          <g className={styles.direction}>
            <circle
              {...common}
              className={styles.arc}
              strokeWidth={sw}
              strokeDasharray={`${pct} 100`}
              transform={`rotate(-90 ${C} ${C})`}
            />
          </g>
        </>
      );
    }
    case 'awaiting':
      return (
        <>
          <circle
            {...common}
            className={styles.warnRing}
            strokeWidth={sw}
            strokeDasharray="84 16"
            strokeDashoffset={-8}
            transform={`rotate(-90 ${C} ${C})`}
          />
          <circle cx={C} cy={C} r={sw * (size >= 40 ? 1.4 : 1)} className={styles.warnCore} />
        </>
      );
    case 'completed':
      return (
        <>
          <circle {...common} className={styles.successRing} strokeWidth={sw} />
          <path
            d="M16.5 24.5 L21.5 29.5 L31.5 19"
            className={styles.successMark}
            strokeWidth={sw}
            fill="none"
          />
        </>
      );
    case 'failed':
      return (
        <>
          <circle {...common} className={styles.dangerRing} strokeWidth={sw} />
          <path d="M24 15.5 V25.5" className={styles.dangerMark} strokeWidth={sw} fill="none" />
          <circle cx={C} cy={31.5} r={sw * 0.62} className={styles.dangerDot} />
        </>
      );
    case 'reconnecting':
    case 'offline':
      return (
        <circle
          {...common}
          className={styles.dashedRing}
          strokeWidth={sw * 0.85}
          strokeDasharray="4.5 3.8"
          transform={`rotate(-90 ${C} ${C})`}
        />
      );
  }
}
