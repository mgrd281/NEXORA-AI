'use client';

import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';

/** Whether a media query matches; false while server rendering. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (callback) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', callback);
      return () => mql.removeEventListener('change', callback);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The desktop layout (sidebar visible). */
export const WIDE_QUERY = '(min-width: 900px)';

/**
 * Whether an element is on screen between the phone's fixed top bar and tab bar. `true` until
 * measured (and when IntersectionObserver is unavailable), so nothing appears by default.
 */
export function useOnScreen(ref: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof IntersectionObserver === 'undefined') return;
    const styles = getComputedStyle(document.documentElement);
    const px = (name: string, fallback: number) =>
      Number.parseFloat(styles.getPropertyValue(name)) || fallback;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? true),
      {
        rootMargin: `-${px('--topbar-height', 52)}px 0px -${px('--tabbar-height', 56)}px 0px`,
        threshold: 1,
      },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return enabled ? visible : true;
}
