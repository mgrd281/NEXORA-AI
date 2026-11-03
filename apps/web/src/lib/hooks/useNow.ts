'use client';

import { useSyncExternalStore } from 'react';

/**
 * One shared minute ticker for every relative timestamp on the page (instead of a timer per
 * component). Returns Date.now() rounded to the last tick; 0 during server rendering.
 */
const listeners = new Set<() => void>();
let now = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const TICK_MS = 60_000;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot() {
  if (now === 0) now = Date.now();
  return now;
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

/** Forces a fresh "now" (e.g. right after new data arrived). */
export function refreshNow(): void {
  now = Date.now();
  for (const l of listeners) l();
}
