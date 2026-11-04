'use client';

import type { CreateTaskRequest, RouteResponse } from '@jarvis/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, newIdempotencyKey, type ApiError } from './client';
import { qk } from './query-keys';

/**
 * Shared queries used by the shell and several screens. Screen-specific queries live with the
 * screens and use `api.call` + the keys in query-keys.ts.
 */

export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: ({ signal }) => api.call('getMe', { signal }) });
}

/** Home snapshot: pending approvals, active and recent tasks, unread count, suggestions. */
export function useHome() {
  return useQuery({ queryKey: qk.home, queryFn: ({ signal }) => api.call('getHome', { signal }) });
}

export function useAssistantStatus() {
  return useQuery({
    queryKey: qk.assistantStatus,
    queryFn: ({ signal }) => api.call('getAssistantStatus', { signal }),
    // Worker health is time-based (heartbeat age), so refresh it periodically.
    refetchInterval: 60_000,
  });
}

/**
 * Time zones the server accepts (Postgres ∩ Intl). Pickers offer only these, so a saved zone is
 * never refused. The list changes only with a server update: cached for an hour.
 */
export function useTimeZones() {
  return useQuery({
    queryKey: qk.timeZones,
    queryFn: ({ signal }) => api.call('listTimeZones', { signal }),
    staleTime: 60 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
  });
}

/** Pending approvals. */
export function useApprovals() {
  return useQuery({
    queryKey: qk.approvals,
    queryFn: ({ signal }) => api.call('listApprovals', { signal }),
  });
}

export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: qk.notifications,
    queryFn: ({ signal }) => api.call('listNotifications', { query: { limit: 30 }, signal }),
    enabled,
  });
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) => api.call('markNotificationsRead', { body: ids ? { ids } : {} }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.notifications });
      void queryClient.invalidateQueries({ queryKey: qk.home });
    },
  });
}

export interface CreateTaskVariables {
  body: CreateTaskRequest;
  /** One key per user intent; keep it when retrying the same submission. */
  idempotencyKey?: string;
}

/** POST /v1/tasks with an Idempotency-Key; refreshes task lists and Home on success. */
export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation<RouteResponse<'createTask'>, ApiError, CreateTaskVariables>({
    mutationFn: ({ body, idempotencyKey }) =>
      api.call('createTask', { body, idempotencyKey: idempotencyKey ?? newIdempotencyKey() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.tasks.lists });
      void queryClient.invalidateQueries({ queryKey: qk.home });
    },
  });
}

/** Signs out (revokes the session server-side), clears cached data and leaves the app. */
export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.call('logout'),
    onSuccess: () => {
      queryClient.clear();
      // A full load (not router.push) drops every in-memory trace of the signed-out account.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign('/sign-in');
    },
  });
}
