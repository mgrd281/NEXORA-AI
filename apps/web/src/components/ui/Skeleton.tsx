import type { CSSProperties } from 'react';
import { cx } from '@/lib/cx';
import styles from './Skeleton.module.css';

/**
 * Loading placeholder matching the final layout's geometry (never fake text). Mark the loading
 * region with aria-busy and give it a label; skeletons themselves are hidden from assistive tech.
 */
export function Skeleton({
  width,
  height = 16,
  radius = 'sm',
  className,
}: {
  width?: number | string;
  height?: number | string;
  radius?: 'xs' | 'sm' | 'md' | 'lg' | 'full';
  className?: string;
}) {
  const style: CSSProperties = {
    inlineSize: typeof width === 'number' ? `${width}px` : width,
    blockSize: typeof height === 'number' ? `${height}px` : height,
    borderRadius: `var(--radius-${radius})`,
  };
  return <span aria-hidden="true" className={cx(styles.skeleton, className)} style={style} />;
}

/** A row-shaped skeleton block for lists (leading circle, two text lines, meta). */
export function SkeletonRow() {
  return (
    <div className={styles.row} aria-hidden="true">
      <Skeleton width={24} height={24} radius="full" />
      <div className={styles.lines}>
        <Skeleton width="62%" height={14} />
        <Skeleton width="38%" height={12} />
      </div>
      <Skeleton width={48} height={12} />
    </div>
  );
}
