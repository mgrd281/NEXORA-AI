'use client';

import type { ConnectionCapability, OAuthProvider } from '@jarvis/contracts';
import { RotateCcw, ShieldPlus } from 'lucide-react';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button, ButtonLink, type ButtonSize, type ButtonVariant } from '@/components/ui/Button';
import { useI18n } from '@/i18n/I18nProvider';
import { PROVIDER_NAME } from '@/i18n/server-message';
import { useConnectionProviders, useConnections, useStartOAuth } from './api';
import { connectionOf, reconnectCapabilities } from './oauth';

/**
 * "Reconnect" for an expired Google / Microsoft connection, or "Allow" for a capability it
 * lacks, from wherever the problem shows (Home "Upcoming", a failed task): it starts the
 * provider's consent for that same connection (same account, incremental) and comes back to
 * `returnTo`. Without the provider's details on hand (still loading, or no connection any
 * more) it is a link to Connections instead — never a dead button.
 */
export function ReconnectButton({
  provider,
  connectionId,
  capability,
  returnTo,
  variant = 'primary',
  size = 'md',
}: {
  provider: OAuthProvider;
  /** The connection to reconnect (default: the user's connection of this provider). */
  connectionId?: string | null;
  /** Ask for this capability (CONNECTION_SCOPE_MISSING) instead of reconnecting as before. */
  capability?: ConnectionCapability | null;
  returnTo: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const { t } = useI18n();
  const connections = useConnections();
  const providers = useConnectionProviders();
  const start = useStartOAuth();
  const info = providers.data?.items.find((p) => p.provider === provider);
  const all = connections.data?.items ?? [];
  const connection =
    (connectionId ? all.find((c) => c.id === connectionId) : null) ?? connectionOf(provider, all);
  const name = PROVIDER_NAME[provider];
  const label = capability ? t('tasks.connection.allow') : t('connections.oauth.expired.reconnect');
  const aria = capability
    ? t('tasks.connection.allowLabel', { provider: name })
    : t('connections.oauth.expired.reconnectLabel', { provider: name });

  if (!info?.configured || !connection) {
    return (
      <ButtonLink href="/connections" variant={variant} size={size} aria-label={aria}>
        {label}
      </ButtonLink>
    );
  }
  const capabilities: ConnectionCapability[] = capability
    ? [capability]
    : reconnectCapabilities(info, connection);
  return (
    <>
      <Button
        variant={variant}
        size={size}
        icon={capability ? ShieldPlus : RotateCcw}
        loading={start.isPending || start.isSuccess}
        aria-label={aria}
        onClick={() =>
          start.mutate({ provider, capabilities, connectionId: connection.id, returnTo })
        }
      >
        {label}
      </Button>
      {start.isError && <ErrorBanner error={start.error} />}
    </>
  );
}
