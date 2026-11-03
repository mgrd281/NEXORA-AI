'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { DangerZone } from '@/features/settings/controls';
import { useI18n } from '@/i18n/I18nProvider';
import { api, type ApiError } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import { countMemories } from './api';
import styles from './memory.module.css';

/** The quiet danger zone at the end of the Memory screen. */
export function DeleteAllMemories({ onDeleted }: { onDeleted: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const deleted = useRef(false);
  // After the dialog has closed (so the page is no longer inert), hand focus to the list.
  useEffect(() => {
    if (open || !deleted.current) return;
    deleted.current = false;
    onDeleted();
  }, [open, onDeleted]);
  return (
    <DangerZone
      headingLevel={2}
      title={t('memory.deleteAll.title')}
      description={t('memory.deleteAll.description')}
      action={
        <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
          {t('memory.deleteAll.button')}
        </Button>
      }
    >
      {open && (
        <DeleteAllDialog
          onClose={() => setOpen(false)}
          onDeleted={() => {
            deleted.current = true;
            setOpen(false);
          }}
        />
      )}
    </DangerZone>
  );
}

function DeleteAllDialog({ onClose, onDeleted }: { onClose: () => void; onDeleted: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // The exact number, counted fresh when the dialog opens (the list may show only a page).
  const count = useQuery({
    queryKey: [...qk.memories.all, 'count'],
    queryFn: ({ signal }) => countMemories(signal),
    staleTime: 0,
    gcTime: 0,
  });
  const remove = useMutation<{ deleted: number }, ApiError>({
    mutationFn: () => api.call('deleteAllMemories'),
    onSuccess: ({ deleted }) => {
      void queryClient.invalidateQueries({ queryKey: qk.memories.all });
      toast({ message: t('memory.deleteAll.done', { count: deleted }) });
      onDeleted();
    },
  });

  const n = count.data;
  return (
    <Dialog
      open
      size="sm"
      onClose={() => {
        if (!remove.isPending) onClose();
      }}
      title={t('memory.deleteAll.dialogTitle')}
      busy={remove.isPending || count.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={remove.isPending}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={n === undefined || n === 0}
            loading={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {n === undefined
              ? t('memory.deleteAll.button')
              : t('memory.deleteAll.confirm', { count: n })}
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody} role="status">
        {count.isPending ? (
          <p className={styles.counting}>
            <Spinner size={16} />
            {t('memory.deleteAll.counting')}
          </p>
        ) : count.isError ? (
          <ErrorBanner
            error={count.error}
            title={t('memory.deleteAll.countFailed')}
            onRetry={() => void count.refetch()}
            retrying={count.isFetching}
          />
        ) : (
          <>
            <p className={styles.dialogLead}>{t('memory.deleteAll.body', { count: n ?? 0 })}</p>
            {n !== 0 && <p className={styles.hint}>{t('memory.deleteAll.consequence')}</p>}
          </>
        )}
      </div>
      {remove.isError && <ErrorBanner error={remove.error} />}
    </Dialog>
  );
}
