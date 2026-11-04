'use client';

import type { OAuthCallbackRequest, OAuthCallbackResult } from '@jarvis/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, CircleCheck, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Page } from '@/components/shell/Page';
import { taskTitle } from '@/components/tasks/TaskRow';
import { Banner, ErrorBanner } from '@/components/ui/Banner';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/i18n/I18nProvider';
import { CAPABILITY_LABEL, PROVIDER_NAME } from '@/i18n/server-message';
import { api, newIdempotencyKey, type ApiError } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import { storeConnection } from './api';
import { callbackRequest, safeReturnTo } from './oauth';
import styles from './connections.module.css';

/**
 * States already sent in this page's lifetime: a state is single use, and React (strict mode,
 * a remount) may run the effect twice — the second request would only be refused.
 */
const sentStates = new Set<string>();

/**
 * The redirect URI page. It forwards the provider's answer (state + code, or the error) to the
 * API from this same session, removes the code from the address bar and history, then shows
 * what was connected and offers to retry the tasks that had failed because the connection had
 * expired, before continuing where the user started (returnTo).
 */
export function CallbackScreen() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  // undefined until the address has been read (after hydration: the server never sees it).
  const [request, setRequest] = useState<OAuthCallbackRequest | null | undefined>(undefined);
  const complete = useMutation<OAuthCallbackResult, ApiError, OAuthCallbackRequest>({
    mutationFn: (body) => api.call('completeOAuthConnection', { body }),
    onSuccess: (result) => storeConnection(queryClient, result.connection),
  });
  const { mutate } = complete;
  // Read once: the address is cleared right after (and React may run the effect twice).
  const read = useRef<OAuthCallbackRequest | null | undefined>(undefined);

  useEffect(() => {
    if (read.current === undefined)
      read.current = callbackRequest(new URLSearchParams(window.location.search));
    const found = read.current;
    // The code is single use and bound to this session; keep it out of the history either way.
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
    setRequest(found);
    if (!found || sentStates.has(found.state)) return;
    sentStates.add(found.state);
    mutate(found);
  }, [mutate]);

  return (
    <Page title={t('connections.callback.title')}>
      <Card className={styles.callback}>
        {request === null ? (
          <div className={styles.callbackBody}>
            <p className={styles.dialogLead}>{t('connections.callback.missing')}</p>
            <div>
              <ButtonLink href="/connections">{t('connections.callback.back')}</ButtonLink>
            </div>
          </div>
        ) : complete.isSuccess ? (
          <Connected result={complete.data} />
        ) : complete.isError ? (
          <div className={styles.callbackBody}>
            <ErrorBanner title={t('connections.callback.failedTitle')} error={complete.error} />
            <div>
              <ButtonLink href="/connections" variant="primary">
                {t('connections.callback.back')}
              </ButtonLink>
            </div>
          </div>
        ) : (
          <p className={styles.callbackWorking} role="status">
            <Spinner size={20} />
            {t('connections.callback.working')}
          </p>
        )}
      </Card>
    </Page>
  );
}

function Connected({ result }: { result: OAuthCallbackResult }) {
  const { t } = useI18n();
  const { connection, resumableTaskIds } = result;
  const name = PROVIDER_NAME[connection.provider];
  const next = safeReturnTo(result.returnTo);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  return (
    <div className={styles.callbackBody}>
      <div className={styles.callbackHead}>
        <span className={styles.callbackIcon} aria-hidden="true">
          <Icon icon={CircleCheck} size={24} />
        </span>
        <div className={styles.titles}>
          <h2 ref={headingRef} tabIndex={-1} className={styles.title}>
            {t('connections.callback.connectedTitle', { provider: name })}
          </h2>
          <p className={styles.summary}>
            {t('connections.callback.connectedBody', {
              account: '⁨' + (connection.accountIdentifier ?? name) + '⁩',
            })}
          </p>
        </div>
      </div>
      <ul className={styles.facts}>
        {(connection.capabilities ?? []).map((c) => (
          <li key={c}>
            <Icon icon={Check} size={16} />
            <span>{t(CAPABILITY_LABEL[c])}</span>
          </li>
        ))}
      </ul>
      {resumableTaskIds.length > 0 && <Resumable ids={resumableTaskIds} />}
      <div>
        <ButtonLink
          href={next}
          variant={resumableTaskIds.length > 0 ? 'secondary' : 'primary'}
          iconEnd={ArrowRight}
          mirrorIcons
        >
          {t('connections.callback.continue')}
        </ButtonLink>
      </div>
    </div>
  );
}

/** Tasks that failed with CONNECTION_EXPIRED for this provider: retry each, now it works. */
function Resumable({ ids }: { ids: readonly string[] }) {
  const { t } = useI18n();
  return (
    <Banner tone="info" title={t('connections.callback.resumableTitle', { count: ids.length })}>
      <p>{t('connections.callback.resumableBody')}</p>
      <ul className={styles.resumable}>
        {ids.map((id) => (
          <ResumableTask key={id} id={id} />
        ))}
      </ul>
    </Banner>
  );
}

function ResumableTask({ id }: { id: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const task = useQuery({
    queryKey: qk.tasks.detail(id),
    queryFn: ({ signal }) => api.call('getTask', { params: { id }, signal }),
  });
  const key = useRef(newIdempotencyKey());
  const retry = useMutation<unknown, ApiError>({
    mutationFn: () =>
      api.call('retryTask', {
        params: { id },
        body: { acknowledgeUnknownOutcome: false },
        idempotencyKey: key.current,
      }),
    onSuccess: () => {
      toast({ message: t('connections.callback.retried') });
      void queryClient.invalidateQueries({ queryKey: qk.tasks.detail(id) });
      void queryClient.invalidateQueries({ queryKey: qk.tasks.lists });
      void queryClient.invalidateQueries({ queryKey: qk.home });
    },
  });
  const title = task.data ? taskTitle(i18n, task.data) : null;
  const retried = retry.isSuccess || (task.data && task.data.status !== 'FAILED');
  return (
    <li className={styles.resumableRow}>
      <Link href={`/tasks/${id}`} className={styles.resumableTitle}>
        {title ? <bdi>{title}</bdi> : t('connections.callback.openTask')}
      </Link>
      {retried ? (
        <span className={styles.resumableDone}>
          <Icon icon={Check} size={16} />
          {t('connections.callback.retried')}
        </span>
      ) : (
        <Button
          size="sm"
          icon={RotateCcw}
          loading={retry.isPending}
          disabled={!task.data?.canRetry}
          aria-label={title ? t('connections.callback.retryLabel', { title }) : undefined}
          onClick={() => retry.mutate()}
        >
          {t('connections.callback.retry')}
        </Button>
      )}
      {retry.isError && (
        <div className={styles.resumableError}>
          <ErrorBanner error={retry.error} />
        </div>
      )}
    </li>
  );
}
