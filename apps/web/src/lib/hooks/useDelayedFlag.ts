'use client';

import { useEffect, useState } from 'react';

/**
 * True only after `value` has stayed true for `delayMs` (false immediately otherwise). Keeps
 * brief, self-healing blips — a stream reconnecting within a second — from flashing UI.
 */
export function useDelayedFlag(value: boolean, delayMs: number): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!value) return;
    const timer = window.setTimeout(() => setSettled(true), delayMs);
    return () => {
      window.clearTimeout(timer);
      setSettled(false);
    };
  }, [value, delayMs]);
  return value && settled;
}
