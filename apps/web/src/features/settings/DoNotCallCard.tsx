'use client';

import type { DoNotCallEntry } from '@jarvis/contracts';
import { PhoneOff, Trash } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/i18n/I18nProvider';
import { isApiError } from '@/lib/api/client';
import { useDeleteDoNotCall, useDoNotCall } from '@/features/calls/api';
import { useRegionName } from '@/components/approvals/PhoneCallDetails';
import { SettingRow, SettingsCard } from './controls';
import styles from './settings.module.css';

/** A masked number reads left to right inside any sentence. */
const ltr = (text: string) => `⁦${text}⁩`;

/**
 * Settings › Privacy: the numbers JARVIS won't call (masked), why each is there, and removing
 * one — with the callee's wish stated plainly first (only to correct a misunderstanding).
 */
export function DoNotCallCard() {
  const { t, f } = useI18n();
  const { toast } = useToast();
  const list = useDoNotCall();
  const remove = useDeleteDoNotCall();
  const region = useRegionName();
  const [confirming, setConfirming] = useState<DoNotCallEntry | null>(null);
  // A server without the route (not deployed yet) has no list to show.
  if (isApiError(list.error, 'NOT_FOUND')) return null;
  const items = list.data?.items ?? [];

  return (
    <SettingsCard>
      <SettingRow>
        <div className={styles.actionText}>
          <h3 className={styles.rowTitle} id="do-not-call">
            {t('settings.doNotCall.title')}
          </h3>
          <p className={styles.rowText}>{t('settings.doNotCall.description')}</p>
        </div>
        {list.isPending ? (
          <Skeleton width="100%" height={48} radius="md" />
        ) : list.isError ? (
          <ErrorBanner
            title={t('settings.doNotCall.loadError')}
            error={list.error}
            onRetry={() => void list.refetch()}
            retrying={list.isFetching}
          />
        ) : items.length === 0 ? (
          <p className={styles.note}>{t('settings.doNotCall.empty')}</p>
        ) : (
          <ul className={styles.dncList}>
            {items.map((entry) => {
              const country = region(entry.country);
              return (
                <li key={entry.id} className={styles.dncItem}>
                  <span className={styles.dncText}>
                    <span className={styles.dncNumber}>
                      <Icon icon={PhoneOff} size={16} />
                      <span className="ltr tabular">{entry.number}</span>
                    </span>
                    <span className={styles.note}>
                      {[
                        t(`settings.doNotCall.sources.${entry.source}`),
                        country,
                        t('settings.doNotCall.added', { date: f.date(entry.createdAt) }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {entry.taskId && (
                      <Link href={`/tasks/${entry.taskId}`} className={styles.recordLink}>
                        {t('settings.doNotCall.openCall')}
                      </Link>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Trash}
                    aria-label={t('settings.doNotCall.removeLabel', { number: ltr(entry.number) })}
                    onClick={() => {
                      remove.reset();
                      setConfirming(entry);
                    }}
                  >
                    {t('settings.doNotCall.remove')}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </SettingRow>
      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={
          confirming ? t('settings.doNotCall.confirmTitle', { number: ltr(confirming.number) }) : ''
        }
        description={
          confirming?.source === 'callee_request'
            ? t('settings.doNotCall.confirmCallee')
            : t('settings.doNotCall.confirmUser')
        }
        size="sm"
        busy={remove.isPending}
        footer={
          <>
            <Button onClick={() => setConfirming(null)} disabled={remove.isPending}>
              {t('settings.doNotCall.keep')}
            </Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() => {
                const entry = confirming;
                if (!entry) return;
                remove.mutate(entry.id, {
                  onSuccess: () => {
                    setConfirming(null);
                    toast({
                      message: t('settings.doNotCall.removed', { number: ltr(entry.number) }),
                    });
                  },
                });
              }}
            >
              {t('settings.doNotCall.confirm')}
            </Button>
          </>
        }
      >
        {remove.isError && <ErrorBanner error={remove.error} />}
      </Dialog>
    </SettingsCard>
  );
}
