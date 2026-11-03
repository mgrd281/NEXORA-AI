'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';

const PAGE_SIZE = 25;

export function useAdminOverview(enabled: boolean) {
  return useQuery({
    queryKey: qk.admin.overview,
    queryFn: ({ signal }) => api.call('adminOverview', { signal }),
    enabled,
    // Worker heartbeat and queue depth are live values.
    refetchInterval: 60_000,
  });
}

export function useAdminUsers(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: qk.admin.users,
    queryFn: ({ pageParam, signal }) =>
      api.call('adminUsers', { query: { cursor: pageParam, limit: PAGE_SIZE }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useAdminAudit(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: qk.admin.audit,
    queryFn: ({ pageParam, signal }) =>
      api.call('adminAudit', { query: { cursor: pageParam, limit: PAGE_SIZE }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}
