'use client';

import type { CallResult, Me, PhoneVerification } from '@jarvis/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isApiError, newIdempotencyKey, type ApiError } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';

export const CALLS_PAGE_SIZE = 25;

/** Task Center › Calls: newest first (keyset pages). */
export function useCalls(result?: CallResult) {
  return useInfiniteQuery({
    queryKey: [...qk.calls.list, result ?? 'all'],
    queryFn: ({ pageParam, signal }) =>
      api.call('listCalls', {
        query: {
          limit: CALLS_PAGE_SIZE,
          ...(result ? { result } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** One call with every turn (TaskDetail.calls holds at most CALL_LIMITS.turnsInTaskDetail). */
export function useCall(id: string, enabled = true) {
  return useQuery({
    queryKey: qk.calls.detail(id),
    queryFn: ({ signal }) => api.call('getCall', { params: { id }, signal }),
    enabled,
    retry: (count, error) => !isApiError(error, 'NOT_FOUND') && count < 2,
  });
}

/** Settings › Privacy: the numbers JARVIS won't call (masked). */
export function useDoNotCall() {
  return useQuery({
    queryKey: qk.doNotCall,
    queryFn: ({ signal }) => api.call('listDoNotCall', { signal }),
    retry: (count, error) => !isApiError(error, 'NOT_FOUND') && count < 2,
  });
}

export function useDeleteDoNotCall() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => api.call('deleteDoNotCall', { params: { id } }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: qk.doNotCall }),
  });
}

/**
 * GET /v1/me/phone/verification: the verification still running (or that just failed), so the
 * code field comes back after a reload or after leaving Settings.
 */
export function useCurrentPhoneVerification(enabled: boolean) {
  return useQuery({
    queryKey: qk.phoneVerification,
    queryFn: ({ signal }) => api.call('getPhoneVerification', { signal }),
    enabled,
    retry: (count, error) => !isApiError(error, 'NOT_FOUND') && count < 2,
  });
}

/** POST /v1/me/phone/verification: JARVIS calls the account's number and reads a code. */
export function useStartPhoneVerification() {
  return useMutation<PhoneVerification, ApiError, void>({
    mutationFn: () => api.call('startPhoneVerification', { idempotencyKey: newIdempotencyKey() }),
  });
}

/** POST /v1/me/phone/verification/confirm: the code from the call; returns the updated Me. */
export function useConfirmPhoneVerification() {
  const queryClient = useQueryClient();
  return useMutation<Me, ApiError, string>({
    mutationFn: (code) => api.call('confirmPhoneVerification', { body: { code } }),
    onSuccess: (me) => queryClient.setQueryData(qk.me, me),
  });
}
