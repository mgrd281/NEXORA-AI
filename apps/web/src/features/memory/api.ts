'use client';

import type { Memory, RouteResponse } from '@jarvis/contracts';
import {
  keepPreviousData,
  useInfiniteQuery,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';

type MemoryPage = RouteResponse<'listMemories'>;
type MemoryPages = InfiniteData<MemoryPage, string | undefined>;

export const MEMORY_PAGE_SIZE = 25;

/** GET /v1/memories (newest first), searchable with `q`, paged by cursor. */
export function useMemories(q: string) {
  return useInfiniteQuery({
    queryKey: qk.memories.list(q),
    queryFn: ({ pageParam, signal }) =>
      api.call('listMemories', {
        query: { q: q || undefined, cursor: pageParam, limit: MEMORY_PAGE_SIZE },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // While a new search loads, keep showing the previous results (dimmed) instead of a flash.
    placeholderData: keepPreviousData,
  });
}

function mapCachedPages(queryClient: QueryClient, fn: (items: Memory[]) => Memory[]): void {
  // Only the paged lists (the same prefix also holds the "Delete all" count).
  queryClient.setQueriesData<MemoryPages>({ queryKey: qk.memories.all }, (data) =>
    data && Array.isArray(data.pages)
      ? { ...data, pages: data.pages.map((p) => ({ ...p, items: fn(p.items) })) }
      : data,
  );
}

/** Puts the server's copy of a changed memory into every cached list. */
export function replaceCachedMemory(queryClient: QueryClient, memory: Memory): void {
  mapCachedPages(queryClient, (items) => items.map((m) => (m.id === memory.id ? memory : m)));
}

export function removeCachedMemory(queryClient: QueryClient, id: string): void {
  mapCachedPages(queryClient, (items) => items.filter((m) => m.id !== id));
}

/** A new memory is the newest one: show it at the top of the unfiltered list right away. */
export function prependCachedMemory(queryClient: QueryClient, memory: Memory): void {
  queryClient.setQueryData<MemoryPages>(qk.memories.list(''), (data) => {
    if (!data || data.pages.length === 0) return data;
    const [first, ...rest] = data.pages;
    if (first!.items.some((m) => m.id === memory.id)) return data;
    return { ...data, pages: [{ ...first!, items: [memory, ...first!.items] }, ...rest] };
  });
}

/** Exact number of memories, by paging through all of them (used before "Delete all"). */
export async function countMemories(signal?: AbortSignal, maxPages = 200): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await api.call('listMemories', { query: { cursor, limit: 100 }, signal });
    count += res.items.length;
    if (!res.nextCursor) return count;
    cursor = res.nextCursor;
  }
  return count;
}
