import type { ReactNode } from 'react';
import styles from './Kbd.module.css';

/** A keyboard key. Combine several for a chord: <Kbd>⌘</Kbd><Kbd>K</Kbd>. */
export function Kbd({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <kbd className={styles.kbd} aria-label={label} dir="ltr">
      {children}
    </kbd>
  );
}
