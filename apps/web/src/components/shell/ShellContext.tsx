'use client';

import { createContext, useContext } from 'react';
import type { PresenceDescriptor } from '@/components/presence/model';

export interface ShellState {
  /** The assistant-wide Presence (real state: connectivity, approvals, running work). */
  presence: PresenceDescriptor;
  /** Pending approvals (from the Home snapshot). */
  pendingApprovals: number;
  unreadNotifications: number;
  isAdmin: boolean;
  /** Voice capture is active somewhere in the app (drives Presence 'listening'). */
  setListening: (listening: boolean) => void;
  openShortcuts: () => void;
}

export const ShellContext = createContext<ShellState | null>(null);

/** Shell state for screens (e.g. Home shows the same Presence as the sidebar). */
export function useShell(): ShellState {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error('useShell must be used inside the app shell');
  return ctx;
}

/** Same as useShell, but null outside the shell (components that also render elsewhere). */
export function useOptionalShell(): ShellState | null {
  return useContext(ShellContext);
}
