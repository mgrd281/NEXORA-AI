'use client';

import type { Connection } from '@jarvis/contracts';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';

export function useConnections() {
  return useQuery({
    queryKey: qk.connections,
    queryFn: ({ signal }) => api.call('listConnections', { signal }),
  });
}

type ConnectionList = { items: Connection[] };

/** Puts the server's copy of a connection into the cache (one active row per provider). */
export function storeConnection(queryClient: QueryClient, connection: Connection): void {
  queryClient.setQueryData<ConnectionList>(qk.connections, (prev) => {
    const others = (prev?.items ?? []).filter(
      (c) => c.id !== connection.id && c.provider !== connection.provider,
    );
    return { items: [...others, connection] };
  });
  refreshDependents(queryClient);
}

export function forgetConnection(queryClient: QueryClient, id: string): void {
  queryClient.setQueryData<ConnectionList>(qk.connections, (prev) =>
    prev ? { items: prev.items.filter((c) => c.id !== id) } : prev,
  );
  refreshDependents(queryClient);
}

/** Connections decide what the assistant can do (capabilities, Home suggestions). */
function refreshDependents(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.connections });
  void queryClient.invalidateQueries({ queryKey: qk.assistantStatus });
  void queryClient.invalidateQueries({ queryKey: qk.home });
}
