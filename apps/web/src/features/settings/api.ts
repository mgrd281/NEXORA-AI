'use client';

import type { Me, UpdateMeRequest } from '@jarvis/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, type ApiError } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** How long "Saved" stays visible after a successful save. */
const SAVED_MS = 2500;

/**
 * PATCH /v1/me for one control. Each control gets its own instance, so its saving / saved /
 * failed state is its own. The server's response replaces the cached profile (the shell then
 * mirrors locale and theme into cookies); preferences change the assistant status, the month's
 * budget and the Home suggestions, so those refresh too.
 */
export function useSaveMe() {
  const queryClient = useQueryClient();
  const [showSaved, setShowSaved] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const mutation = useMutation<Me, ApiError, UpdateMeRequest>({
    mutationFn: (body) => api.call('updateMe', { body }),
    onMutate: () => {
      window.clearTimeout(timer.current);
      setShowSaved(false);
    },
    onSuccess: (me, body) => {
      queryClient.setQueryData(qk.me, me);
      if (body.preferences || body.timeZone) {
        void queryClient.invalidateQueries({ queryKey: qk.assistantStatus });
        void queryClient.invalidateQueries({ queryKey: qk.usage });
        void queryClient.invalidateQueries({ queryKey: qk.home });
        // Memory and external models decide whether some skills can run.
        void queryClient.invalidateQueries({ queryKey: qk.skills });
      }
      setShowSaved(true);
      timer.current = window.setTimeout(() => setShowSaved(false), SAVED_MS);
    },
  });

  const state: SaveState = mutation.isPending
    ? 'saving'
    : mutation.isError
      ? 'error'
      : showSaved
        ? 'saved'
        : 'idle';

  return {
    save: mutation.mutate,
    saveAsync: mutation.mutateAsync,
    state,
    error: mutation.error,
    pending: mutation.isPending,
    /** The body being saved right now (for showing the new value while it saves). */
    variables: mutation.isPending ? mutation.variables : undefined,
  };
}

export function useUsage() {
  return useQuery({
    queryKey: qk.usage,
    queryFn: ({ signal }) => api.call('getUsage', { signal }),
  });
}

export function useSessions() {
  return useQuery({
    queryKey: qk.sessions,
    queryFn: ({ signal }) => api.call('listSessions', { signal }),
  });
}
