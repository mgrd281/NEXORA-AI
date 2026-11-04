'use client';

import type { ConversationDetail } from '@jarvis/contracts';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { api, isApiError, type ApiError } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';

export const CONVERSATION_PAGE_SIZE = 25;
/** Tasks per thread page (the newest first; earlier ones load on request). */
export const THREAD_PAGE_TASKS = 50;

/** Conversation history, most recent activity first, with an optional search (`q`). */
export function useConversationList(q: string) {
  return useInfiniteQuery({
    queryKey: qk.conversations.list(q),
    queryFn: ({ pageParam, signal }) =>
      api.call('listConversations', {
        query: {
          limit: CONVERSATION_PAGE_SIZE,
          ...(q ? { q } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: (previous) => previous,
  });
}

/**
 * One conversation thread. The first page holds the newest tasks' turns; each further page
 * (fetchNextPage) the turns of earlier tasks. A 404 is final.
 */
export function useConversation(id: string | null | undefined) {
  return useInfiniteQuery({
    queryKey: qk.conversations.detail(id ?? 'none'),
    queryFn: ({ pageParam, signal }) =>
      api.call('getConversation', {
        params: { id: id! },
        query: { limit: THREAD_PAGE_TASKS, ...(pageParam ? { before: pageParam } : {}) },
        signal,
      }),
    enabled: Boolean(id),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.earlierCursor,
    retry: (count, error) => !isApiError(error, 'NOT_FOUND') && count < 2,
  });
}

/** All loaded turns in thread order (earlier pages first), with the newest page's state. */
export function threadOf(data: InfiniteData<ConversationDetail> | undefined) {
  if (!data || data.pages.length === 0) return null;
  const newest = data.pages[0]!;
  const turns = [...data.pages].reverse().flatMap((page) => page.turns);
  return { ...newest, turns };
}

export function useDeleteConversation(id: string) {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError>({
    mutationFn: () => api.call('deleteConversation', { params: { id } }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: qk.conversations.detail(id) });
      void queryClient.invalidateQueries({ queryKey: qk.conversations.all });
      void queryClient.invalidateQueries({ queryKey: qk.tasks.all });
      void queryClient.invalidateQueries({ queryKey: qk.home });
      void queryClient.invalidateQueries({ queryKey: qk.schedules.all });
    },
  });
}
