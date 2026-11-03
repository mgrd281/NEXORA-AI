'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';

export interface ComposerHandle {
  focus: () => void;
  /** Replaces the text (e.g. a suggestion) and focuses the composer; the user still submits. */
  setText: (text: string) => void;
}

interface Registry {
  register: (handle: ComposerHandle) => () => void;
  /** Focus the registered composer, or go Home and focus it there. */
  focusComposer: () => void;
  /** Put text into the composer (going Home first when none is on screen). */
  fillComposer: (text: string) => void;
}

const ComposerRegistryContext = createContext<Registry | null>(null);

/** Lets shortcuts (⌘/Ctrl+K, '/') and suggestions reach the command composer. */
export function ComposerRegistryProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const current = useRef<ComposerHandle | null>(null);
  const pending = useRef<{ text?: string } | null>(null);

  const register = useCallback((handle: ComposerHandle) => {
    current.current = handle;
    const p = pending.current;
    if (p) {
      pending.current = null;
      // Wait a frame so the new page has painted before moving focus.
      requestAnimationFrame(() => (p.text !== undefined ? handle.setText(p.text) : handle.focus()));
    }
    return () => {
      if (current.current === handle) current.current = null;
    };
  }, []);

  const focusComposer = useCallback(() => {
    if (current.current) current.current.focus();
    else {
      pending.current = {};
      if (pathname !== '/') router.push('/');
    }
  }, [pathname, router]);

  const fillComposer = useCallback(
    (text: string) => {
      if (current.current) current.current.setText(text);
      else {
        pending.current = { text };
        if (pathname !== '/') router.push('/');
      }
    },
    [pathname, router],
  );

  const value = useMemo(
    () => ({ register, focusComposer, fillComposer }),
    [register, focusComposer, fillComposer],
  );
  return (
    <ComposerRegistryContext.Provider value={value}>{children}</ComposerRegistryContext.Provider>
  );
}

export function useComposerRegistry(): Registry | null {
  return useContext(ComposerRegistryContext);
}
