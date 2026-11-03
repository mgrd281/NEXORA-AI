'use client';

import type { Connection, Me } from '@jarvis/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Inbox, Mail, Send } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Banner, ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/i18n/I18nProvider';
import { api, type ApiError } from '@/lib/api/client';
import { forgetConnection, storeConnection } from './api';
import { ConnectionCard } from './ConnectionCard';
import { SmtpForm } from './SmtpForm';
import styles from './connections.module.css';

export function EmailCard({
  connection,
  me,
}: {
  connection: Connection | null;
  me: Me | undefined;
}) {
  const { t } = useI18n();
  const [updating, setUpdating] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const account = { email: me?.email ?? '', displayName: me?.displayName ?? '' };
  // Focus moves to the card heading once the change is on screen and any dialog is gone (an
  // open modal <dialog> makes the rest of the page inert, so focusing earlier would be lost).
  const focusPending = useRef(false);
  const focusCard = () => {
    focusPending.current = true;
  };
  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    headingRef.current?.focus();
  }, [connection, updating]);

  return (
    <ConnectionCard
      ref={headingRef}
      icon={Mail}
      title={t('connections.email.title')}
      summary={t('connections.email.summary')}
      status={connection?.status ?? null}
      footer={
        connection && !updating ? (
          <ConnectedActions
            connection={connection}
            onUpdate={() => setUpdating(true)}
            onDisconnected={focusCard}
          />
        ) : undefined
      }
    >
      {connection && !updating ? (
        <ConnectedDetails connection={connection} />
      ) : (
        <SmtpForm
          // A fresh form (and no password in memory) every time it opens.
          key={connection?.id ?? 'new'}
          account={account}
          onConnected={() => {
            setUpdating(false);
            focusCard();
          }}
          onCancel={
            connection
              ? () => {
                  setUpdating(false);
                  focusCard();
                }
              : undefined
          }
        />
      )}
    </ConnectionCard>
  );
}

function ConnectedDetails({ connection }: { connection: Connection }) {
  const { t } = useI18n();
  const listId = useId();
  const address = connection.accountIdentifier ?? '';
  // The name is only worth showing when the person chose one (not the default or the address).
  const customLabel = ![address, 'Email', t('connections.email.title')].includes(connection.label);
  return (
    <>
      <dl className={styles.details}>
        <div>
          <dt>{t('connections.email.sendsAs')}</dt>
          <dd>
            <span className="ltr">{address}</span>
            {customLabel && (
              <span className={styles.detailNote} dir="auto">
                {connection.label}
              </span>
            )}
          </dd>
        </div>
      </dl>
      {connection.status !== 'active' && connection.lastError && (
        <Banner tone="danger" title={t('connections.email.lastErrorTitle')}>
          <p dir="auto">{connection.lastError}</p>
        </Banner>
      )}
      <h3 id={listId} className={styles.subTitle}>
        {t('connections.email.permissionsTitle')}
      </h3>
      <ul className={styles.facts} aria-labelledby={listId}>
        {connection.permissions.includes('email.send') && (
          <li>
            <Icon icon={Send} size={16} mirror />
            <span>{t('connections.email.permissions.send', { address: '⁨' + address + '⁩' })}</span>
          </li>
        )}
        <li>
          <Icon icon={Inbox} size={16} />
          <span>{t('connections.email.permissions.noRead')}</span>
        </li>
      </ul>
    </>
  );
}

function ConnectedActions({
  connection,
  onUpdate,
  onDisconnected,
}: {
  connection: Connection;
  onUpdate: () => void;
  onDisconnected: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const test = useMutation<Connection, ApiError>({
    mutationFn: () => api.call('testConnection', { params: { id: connection.id } }),
    onSuccess: (checked) => {
      storeConnection(queryClient, checked);
      toast(
        checked.status === 'active'
          ? { message: t('connections.email.testOk') }
          : { tone: 'error', message: t('connections.email.testFailed') },
      );
    },
  });

  return (
    <>
      <span className={styles.meta}>
        {connection.lastVerifiedAt ? (
          <RelativeTime
            value={connection.lastVerifiedAt}
            format={(time) => t('connections.email.lastVerified', { time })}
          />
        ) : (
          t('connections.email.neverVerified')
        )}
      </span>
      <div className={styles.actions}>
        <Button variant="danger" onClick={() => setConfirming(true)}>
          {t('connections.email.disconnect')}
        </Button>
        <Button variant="ghost" onClick={onUpdate}>
          {t('connections.email.update')}
        </Button>
        <Button loading={test.isPending} onClick={() => test.mutate()}>
          {t('connections.email.test')}
        </Button>
      </div>
      {test.isError && (
        <div className={styles.footerError}>
          <ErrorBanner error={test.error} onRetry={() => test.mutate()} retrying={test.isPending} />
        </div>
      )}
      {confirming && (
        <DisconnectDialog
          connection={connection}
          onClose={() => setConfirming(false)}
          onDisconnected={onDisconnected}
        />
      )}
    </>
  );
}

function DisconnectDialog({
  connection,
  onClose,
  onDisconnected,
}: {
  connection: Connection;
  onClose: () => void;
  onDisconnected: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const remove = useMutation<void, ApiError>({
    mutationFn: () => api.call('deleteConnection', { params: { id: connection.id } }),
    onSuccess: () => {
      forgetConnection(queryClient, connection.id);
      toast({ message: t('connections.email.disconnected') });
      onDisconnected();
    },
  });
  return (
    <Dialog
      open
      size="sm"
      onClose={() => {
        if (!remove.isPending) onClose();
      }}
      title={t('connections.email.disconnectDialog.title')}
      busy={remove.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={remove.isPending}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="destructive" loading={remove.isPending} onClick={() => remove.mutate()}>
            {t('connections.email.disconnectDialog.confirm')}
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <p className={styles.dialogLead}>
          {t('connections.email.disconnectDialog.body', {
            address: '⁨' + (connection.accountIdentifier ?? '') + '⁩',
          })}
        </p>
        <p className={styles.hint}>{t('connections.email.disconnectDialog.erase')}</p>
        {remove.isError && <ErrorBanner error={remove.error} />}
      </div>
    </Dialog>
  );
}
