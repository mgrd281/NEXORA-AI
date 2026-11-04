'use client';

import type {
  CreateWebhookRequest,
  UpdateWebhookRequest,
  WebhookDelivery,
  WebhookDeliveryEventType,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
} from '@jarvis/contracts';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type { MessageKey } from '@/i18n/catalog';
import { api, type ApiError } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';

export function useWebhooks() {
  return useQuery({
    queryKey: qk.webhooks.list,
    queryFn: ({ signal }) => api.call('listWebhooks', { signal }),
  });
}

export function useWebhookDeliveries(id: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: qk.webhooks.deliveries(id),
    queryFn: ({ pageParam, signal }) =>
      api.call('listWebhookDeliveries', {
        params: { id },
        query: { limit: 10, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      }),
    enabled,
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // Pending deliveries change on their own (retries): refresh while the log is open.
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) => p.items.some((d) => d.status === 'pending'))
        ? 5000
        : false,
  });
}

function store(queryClient: QueryClient, endpoint: WebhookEndpoint) {
  queryClient.setQueryData<{ items: WebhookEndpoint[] }>(qk.webhooks.list, (prev) => {
    if (!prev) return prev;
    const found = prev.items.some((e) => e.id === endpoint.id);
    return {
      items: found
        ? prev.items.map((e) => (e.id === endpoint.id ? endpoint : e))
        : [...prev.items, endpoint],
    };
  });
  void queryClient.invalidateQueries({ queryKey: qk.webhooks.list });
}

/** Not idempotent on purpose: the one-time secret must never be stored for replays. */
export function useCreateWebhook() {
  const queryClient = useQueryClient();
  return useMutation<WebhookEndpointWithSecret, ApiError, CreateWebhookRequest>({
    mutationFn: (body) => api.call('createWebhook', { body }),
    onSuccess: ({ endpoint }) => store(queryClient, endpoint),
  });
}

export function useUpdateWebhook(id: string) {
  const queryClient = useQueryClient();
  return useMutation<WebhookEndpoint, ApiError, UpdateWebhookRequest>({
    mutationFn: (body) => api.call('updateWebhook', { params: { id }, body }),
    onSuccess: (endpoint) => store(queryClient, endpoint),
  });
}

export function useRotateWebhookSecret(id: string) {
  const queryClient = useQueryClient();
  return useMutation<WebhookEndpointWithSecret, ApiError>({
    mutationFn: () => api.call('rotateWebhookSecret', { params: { id } }),
    onSuccess: ({ endpoint }) => store(queryClient, endpoint),
  });
}

export function useTestWebhook(id: string) {
  const queryClient = useQueryClient();
  return useMutation<WebhookDelivery, ApiError>({
    mutationFn: () => api.call('testWebhook', { params: { id } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.webhooks.deliveries(id) });
      void queryClient.invalidateQueries({ queryKey: qk.webhooks.list });
    },
  });
}

export function useDeleteWebhook(id: string) {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError>({
    mutationFn: () => api.call('deleteWebhook', { params: { id } }),
    onSuccess: () => {
      queryClient.setQueryData<{ items: WebhookEndpoint[] }>(qk.webhooks.list, (prev) =>
        prev ? { items: prev.items.filter((e) => e.id !== id) } : prev,
      );
      queryClient.removeQueries({ queryKey: qk.webhooks.deliveries(id) });
      void queryClient.invalidateQueries({ queryKey: qk.webhooks.list });
    },
  });
}

/** 'task.completed' → 'webhooks.eventTypes.taskCompleted'. */
export function eventTypeKey(type: WebhookDeliveryEventType): MessageKey {
  const camel = type.replace(/\.(\w)/g, (_, c: string) => c.toUpperCase());
  return `webhooks.eventTypes.${camel}` as MessageKey;
}

/** The host of an endpoint URL, for names and confirmations. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A full http(s) URL without credentials or fragment (the server checks the rest). */
export function isPlausibleWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname !== '' &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}
