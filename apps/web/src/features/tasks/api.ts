'use client';

import { canCancel, canRetry, type TaskDetail, type TaskSummary } from '@jarvis/contracts';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useRef } from 'react';
import { api, isApiError, newIdempotencyKey, type ApiError } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import type { TaskFilter } from './model';

export const TASK_PAGE_SIZE = 25;

/**
 * One Task Center list per filter, paged by cursor. Realtime task events invalidate
 * qk.tasks.lists, which refetches every loaded page, so the list reconciles with the server.
 */
export function useTaskList(filter: TaskFilter) {
  return useInfiniteQuery({
    queryKey: qk.tasks.list(filter),
    queryFn: ({ pageParam, signal }) =>
      api.call('listTasks', {
        query: {
          status: filter,
          limit: TASK_PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Task detail; a 404 is final (no retries). */
export function useTaskDetail(id: string, enabled = true) {
  return useQuery({
    queryKey: qk.tasks.detail(id),
    queryFn: ({ signal }) => api.call('getTask', { params: { id }, signal }),
    enabled,
    retry: (count, error) =>
      !isApiError(error, 'NOT_FOUND') && !isApiError(error, 'VALIDATION_FAILED') && count < 2,
  });
}

/** Writes the server's new summary into the cached detail, then refetches the full detail. */
function reconcile(queryClient: QueryClient, summary: TaskSummary) {
  queryClient.setQueryData<TaskDetail>(qk.tasks.detail(summary.id), (old) =>
    old
      ? {
          ...old,
          ...summary,
          canCancel: canCancel(summary.status),
          canRetry: canRetry(summary.status),
        }
      : old,
  );
  void queryClient.invalidateQueries({ queryKey: qk.tasks.detail(summary.id) });
  void queryClient.invalidateQueries({ queryKey: qk.tasks.lists });
  void queryClient.invalidateQueries({ queryKey: qk.home });
  void queryClient.invalidateQueries({ queryKey: qk.approvals });
}

export function useCancelTask(id: string) {
  const queryClient = useQueryClient();
  return useMutation<TaskSummary, ApiError, void>({
    mutationFn: () => api.call('cancelTask', { params: { id } }),
    onSuccess: (summary) => reconcile(queryClient, summary),
    onError: (error) => {
      // The task moved on in the meantime (e.g. it finished): show the real state.
      if (isApiError(error, 'INVALID_STATE')) {
        void queryClient.invalidateQueries({ queryKey: qk.tasks.detail(id) });
      }
    },
  });
}

/**
 * Retry from the failed step. One Idempotency-Key per attempt being retried (and per
 * acknowledgement), reused if the same retry is sent again after a network error.
 */
export function useRetryTask(id: string, attempt: number) {
  const queryClient = useQueryClient();
  const keys = useRef(new Map<string, string>());
  return useMutation<TaskSummary, ApiError, { acknowledgeUnknownOutcome: boolean }>({
    mutationFn: ({ acknowledgeUnknownOutcome }) => {
      const keyId = `${id}:${attempt}:${acknowledgeUnknownOutcome}`;
      let key = keys.current.get(keyId);
      if (!key) {
        key = newIdempotencyKey();
        keys.current.set(keyId, key);
      }
      return api.call('retryTask', {
        params: { id },
        body: { acknowledgeUnknownOutcome },
        idempotencyKey: key,
      });
    },
    onSuccess: (summary) => reconcile(queryClient, summary),
    onError: (error) => {
      if (isApiError(error, 'INVALID_STATE')) {
        void queryClient.invalidateQueries({ queryKey: qk.tasks.detail(id) });
      }
    },
  });
}
