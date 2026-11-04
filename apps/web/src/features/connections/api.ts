'use client';

import type {
  Connection,
  ConnectionCapability,
  OAuthProvider,
  OAuthStartResponse,
} from '@jarvis/contracts';
import { useMutation, useQuery, type QueryClient } from '@tanstack/react-query';
import { api, type ApiError } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import { safeAuthorizationUrl } from './oauth';

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
  void queryClient.invalidateQueries({ queryKey: qk.skills });
  void queryClient.invalidateQueries({ queryKey: qk.calendar.all });
}

/* ------------------------------------------------------------------ Phase C: OAuth */

/** The connection providers this server offers: configured or not, capabilities and scopes. */
export function useConnectionProviders() {
  return useQuery({
    queryKey: qk.connectionProviders,
    queryFn: ({ signal }) => api.call('listConnectionProviders', { signal }),
    // What the server is configured with changes only on a redeploy.
    staleTime: 5 * 60_000,
  });
}

/** The page the provider sends the user back to (one of the server's OAUTH_REDIRECT_URIS). */
export const OAUTH_CALLBACK_PATH = '/connections/callback';

export function oauthRedirectUri(origin: string = window.location.origin): string {
  return `${origin}${OAUTH_CALLBACK_PATH}`;
}

export interface StartOAuthInput {
  provider: OAuthProvider;
  capabilities: ConnectionCapability[];
  /** Reconnect, or add capabilities to, this connection (same provider account). */
  connectionId?: string;
  /** Where to continue after the callback page (a path of this app). */
  returnTo?: string;
}

/**
 * Starts an authorization (code + PKCE on the server) and leaves for the provider's consent
 * page. The page navigates away on success, so the mutation stays pending until then; the URL
 * is followed only when it is an http(s) address (never javascript: or data:).
 */
export function useStartOAuth() {
  return useMutation<OAuthStartResponse, ApiError, StartOAuthInput>({
    mutationFn: ({ provider, capabilities, connectionId, returnTo }) =>
      api.call('startOAuthConnection', {
        body: {
          provider,
          capabilities,
          redirectUri: oauthRedirectUri(),
          ...(connectionId ? { connectionId } : {}),
          ...(returnTo ? { returnTo } : {}),
        },
      }),
    onSuccess: (started) => {
      const target = safeAuthorizationUrl(started.authorizationUrl);
      if (target) window.location.assign(target);
    },
  });
}
