'use client';

import type { WebhookDelivery, WebhookEndpoint, WebhookEventType } from '@jarvis/contracts';
import { WEBHOOK_LIMITS, WebhookEventType as WebhookEventTypeEnum } from '@jarvis/contracts';
import type { LucideIcon } from 'lucide-react';
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  KeyRound,
  Lock,
  Plus,
  Send,
  ShieldCheck,
  Trash,
  TriangleAlert,
  Webhook,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { StatusPill, type Tone } from '@/components/ui/Badge';
import { Banner, ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { Dialog } from '@/components/ui/Dialog';
import { TextField } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { UserText } from '@/components/ui/UserText';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from '@/lib/cx';
import {
  eventTypeKey,
  hostOf,
  isPlausibleWebhookUrl,
  useCreateWebhook,
  useDeleteWebhook,
  useRotateWebhookSecret,
  useTestWebhook,
  useUpdateWebhook,
  useWebhookDeliveries,
  useWebhooks,
} from './api';
import styles from './Webhooks.module.css';

const EVENT_TYPES = WebhookEventTypeEnum.options;

/**
 * Connections › Developer: outbound webhooks. Endpoints with their state and delivery log, a
 * signed test, and the signing secret shown exactly once (on add and on replacement). What a
 * payload can contain is said up front: ids, types, statuses and times — never content.
 */
export function DeveloperSection() {
  const { t } = useI18n();
  const webhooks = useWebhooks();
  const headingId = useId();
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ value: string; rotated: boolean } | null>(null);
  const items = webhooks.data?.items ?? [];
  const atLimit = items.length >= WEBHOOK_LIMITS.maxEndpointsPerUser;
  const loaded = webhooks.data !== undefined;

  // /connections#developer (e.g. from a "webhook turned off" notification) lands here once the
  // section has its content, since the page above it loads first.
  useEffect(() => {
    if (!loaded || window.location.hash !== '#developer') return;
    document.getElementById('developer')?.scrollIntoView({ block: 'start' });
  }, [loaded]);

  return (
    <section id="developer" className={styles.section} aria-labelledby={headingId}>
      <div className={styles.sectionHead}>
        <h2 id={headingId} className={styles.sectionTitle}>
          {t('webhooks.sectionTitle')}
        </h2>
        <p className={styles.sectionDescription}>{t('webhooks.sectionDescription')}</p>
      </div>
      <div className={styles.card}>
        <header className={styles.header}>
          <span className={styles.iconTile} aria-hidden="true">
            <Icon icon={Webhook} size={20} />
          </span>
          <div className={styles.titles}>
            <h3 className={styles.title}>{t('webhooks.title')}</h3>
            <p className={styles.summary}>{t('webhooks.summary')}</p>
          </div>
          <div className={styles.headerAction}>
            <Button
              icon={Plus}
              onClick={() => setAdding(true)}
              disabled={atLimit || !webhooks.data}
            >
              {t('webhooks.add')}
            </Button>
          </div>
        </header>
        <div className={styles.body}>
          <ul className={styles.facts}>
            <li>
              <Icon icon={Lock} size={16} />
              <span>{t('webhooks.privacy')}</span>
            </li>
            <li>
              <Icon icon={ShieldCheck} size={16} />
              <span>{t('webhooks.signing')}</span>
            </li>
          </ul>
          {webhooks.isPending ? (
            <div className={styles.skeleton} aria-busy="true">
              <span className="visually-hidden" role="status">
                {t('webhooks.loading')}
              </span>
              <Skeleton width="50%" height={16} />
              <Skeleton width="80%" height={12} />
            </div>
          ) : webhooks.isError && !webhooks.data ? (
            <ErrorBanner
              title={t('webhooks.loadError')}
              error={webhooks.error}
              onRetry={() => void webhooks.refetch()}
              retrying={webhooks.isFetching}
            />
          ) : items.length === 0 ? (
            <p className={styles.empty}>{t('webhooks.empty')}</p>
          ) : (
            // eslint-disable-next-line jsx-a11y/no-redundant-roles -- list-style: none drops it in Safari
            <ul className={styles.endpoints} role="list" aria-label={t('webhooks.listLabel')}>
              {items.map((endpoint) => (
                <li key={endpoint.id}>
                  <EndpointItem
                    endpoint={endpoint}
                    onSecret={(value) => setSecret({ value, rotated: true })}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        {items.length > 0 && (
          <footer className={styles.footer}>
            <span className={styles.meta}>
              {t('webhooks.limit', {
                count: items.length,
                max: WEBHOOK_LIMITS.maxEndpointsPerUser,
              })}
            </span>
          </footer>
        )}
      </div>
      {adding && (
        <AddEndpointDialog
          onClose={() => setAdding(false)}
          onCreated={(value) => {
            setAdding(false);
            setSecret({ value, rotated: false });
          }}
        />
      )}
      {secret && (
        <SecretDialog
          secret={secret.value}
          rotated={secret.rotated}
          onClose={() => setSecret(null)}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ endpoint */

const ENDPOINT_STATUS: Record<WebhookEndpoint['status'], { tone: Tone; icon: LucideIcon }> = {
  active: { tone: 'success', icon: CircleCheck },
  disabled: { tone: 'neutral', icon: CircleDashed },
};

function EndpointItem({
  endpoint,
  onSecret,
}: {
  endpoint: WebhookEndpoint;
  onSecret: (secret: string) => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const host = hostOf(endpoint.url);
  const deliveriesId = useId();
  const [logOpen, setLogOpen] = useState(false);
  const [confirm, setConfirm] = useState<'rotate' | 'delete' | null>(null);
  const update = useUpdateWebhook(endpoint.id);
  const test = useTestWebhook(endpoint.id);
  const rotate = useRotateWebhookSecret(endpoint.id);
  const remove = useDeleteWebhook(endpoint.id);
  const active = endpoint.status === 'active';
  const failedOff = endpoint.status === 'disabled' && endpoint.disabledReason === 'failures';
  const status = ENDPOINT_STATUS[endpoint.status];
  const shownEnabled = update.isPending && update.variables?.enabled !== undefined
    ? update.variables.enabled
    : active;
  const error = update.error ?? test.error;

  return (
    <article className={styles.endpoint} aria-label={host}>
      <div className={styles.endpointHead}>
        <div className={styles.endpointTitles}>
          <p className={cx(styles.url, 'ltr')} title={endpoint.url}>
            {endpoint.url}
          </p>
          {endpoint.description && (
            <UserText as="p" className={styles.description}>
              {endpoint.description}
            </UserText>
          )}
        </div>
        <StatusPill
          tone={failedOff ? 'warning' : status.tone}
          icon={failedOff ? TriangleAlert : status.icon}
          label={t(`webhooks.status.${endpoint.status}`)}
        />
      </div>

      {endpoint.status === 'disabled' && (
        failedOff ? (
          <Banner
            tone="warning"
            title={t('webhooks.disabledReason.failures', {
              count: WEBHOOK_LIMITS.disableAfterFailedDeliveries,
            })}
          />
        ) : (
          <p className={styles.note}>{t('webhooks.disabledReason.user')}</p>
        )
      )}

      <dl className={styles.endpointMeta}>
        <div>
          <dt className="visually-hidden">{t('webhooks.form.eventsLegend')}</dt>
          <dd title={endpoint.eventTypes.map((e) => t(eventTypeKey(e))).join(', ')}>
            {t('webhooks.events', { count: endpoint.eventTypes.length })}
          </dd>
        </div>
        <div>
          <dt className="visually-hidden">{t('webhooks.deliveries.label', { host })}</dt>
          <dd>
            {endpoint.lastDeliveryAt ? (
              <RelativeTime
                value={endpoint.lastDeliveryAt}
                format={(time) => t('webhooks.lastDelivery', { time })}
              />
            ) : (
              t('webhooks.noDeliveries')
            )}
          </dd>
        </div>
        {endpoint.consecutiveFailures > 0 && active && (
          <div>
            <dt className="visually-hidden">{t('webhooks.deliveries.status.failed')}</dt>
            <dd className={styles.failing}>
              {t('webhooks.failing', { count: endpoint.consecutiveFailures })}
            </dd>
          </div>
        )}
        <div>
          <dt className="visually-hidden">{t('webhooks.secret.label')}</dt>
          <dd className={styles.secretHint}>
            <Icon icon={KeyRound} size={16} />
            <span>{t('webhooks.secretHint', { hint: endpoint.secretHint })}</span>
          </dd>
        </div>
      </dl>

      <Switch
        checked={shownEnabled}
        busy={update.isPending}
        label={
          <>
            {t('webhooks.enabled')}
            <span className="visually-hidden"> — {host}</span>
          </>
        }
        onChange={(enabled) => {
          if (update.isPending) return;
          update.mutate(
            { enabled },
            {
              onSuccess: () =>
                toast({
                  message: enabled ? t('webhooks.toasts.turnedOn') : t('webhooks.toasts.turnedOff'),
                }),
            },
          );
        }}
        className={styles.switch}
      />

      {error && <ErrorBanner error={error} />}

      <div className={styles.actions}>
        <Button
          size="sm"
          icon={Send}
          disabled={!active}
          loading={test.isPending}
          aria-label={t('webhooks.actionFor', { action: t('webhooks.actions.test'), host })}
          onClick={() =>
            test.mutate(undefined, {
              onSuccess: () => {
                setLogOpen(true);
                toast({ message: t('webhooks.toasts.testQueued') });
              },
            })
          }
        >
          {t('webhooks.actions.test')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          iconEnd={ChevronDown}
          aria-expanded={logOpen}
          aria-controls={logOpen ? deliveriesId : undefined}
          className={styles.logToggle}
          onClick={() => setLogOpen((v) => !v)}
        >
          {logOpen ? t('webhooks.actions.hideDeliveries') : t('webhooks.actions.deliveries')}
        </Button>
        <span className={styles.actionsEnd}>
          <Button
            size="sm"
            variant="ghost"
            icon={KeyRound}
            aria-label={t('webhooks.actionFor', { action: t('webhooks.actions.rotate'), host })}
            onClick={() => setConfirm('rotate')}
          >
            {t('webhooks.actions.rotate')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={Trash}
            aria-label={t('webhooks.actionFor', { action: t('webhooks.actions.delete'), host })}
            onClick={() => setConfirm('delete')}
          >
            {t('webhooks.actions.delete')}
          </Button>
        </span>
      </div>

      {logOpen && (
        <div id={deliveriesId}>
          <DeliveryLog endpointId={endpoint.id} host={host} />
        </div>
      )}

      <Dialog
        open={confirm === 'rotate'}
        onClose={() => {
          if (!rotate.isPending) setConfirm(null);
        }}
        title={t('webhooks.rotateDialog.title')}
        description={t('webhooks.rotateDialog.body')}
        dismissible={!rotate.isPending}
        busy={rotate.isPending}
        footer={
          <>
            <Button onClick={() => setConfirm(null)} disabled={rotate.isPending}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={rotate.isPending}
              onClick={() =>
                rotate.mutate(undefined, {
                  onSuccess: ({ secret }) => {
                    setConfirm(null);
                    onSecret(secret);
                  },
                })
              }
            >
              {t('webhooks.rotateDialog.confirm')}
            </Button>
          </>
        }
      >
        {rotate.isError && <ErrorBanner error={rotate.error} />}
      </Dialog>
      <Dialog
        open={confirm === 'delete'}
        onClose={() => {
          if (!remove.isPending) setConfirm(null);
        }}
        title={t('webhooks.deleteDialog.title')}
        description={t('webhooks.deleteDialog.body', { host })}
        dismissible={!remove.isPending}
        busy={remove.isPending}
        footer={
          <>
            <Button onClick={() => setConfirm(null)} disabled={remove.isPending}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    setConfirm(null);
                    toast({ message: t('webhooks.toasts.deleted') });
                  },
                })
              }
            >
              {t('webhooks.deleteDialog.confirm')}
            </Button>
          </>
        }
      >
        {remove.isError && <ErrorBanner error={remove.error} />}
      </Dialog>
    </article>
  );
}

/* ------------------------------------------------------------------ deliveries */

const DELIVERY_STATUS: Record<WebhookDelivery['status'], { tone: Tone; icon: LucideIcon }> = {
  pending: { tone: 'neutral', icon: Clock },
  succeeded: { tone: 'success', icon: CircleCheck },
  failed: { tone: 'danger', icon: CircleAlert },
};

function DeliveryLog({ endpointId, host }: { endpointId: string; host: string }) {
  const { t } = useI18n();
  const log = useWebhookDeliveries(endpointId, true);
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];
  if (log.isPending) {
    return (
      <div className={styles.log} aria-busy="true">
        <span className="visually-hidden" role="status">
          {t('webhooks.deliveries.loading')}
        </span>
        <Skeleton width="60%" height={14} />
        <Skeleton width="45%" height={14} />
      </div>
    );
  }
  if (log.isError && items.length === 0) {
    return (
      <ErrorBanner
        title={t('webhooks.deliveries.loadError')}
        error={log.error}
        onRetry={() => void log.refetch()}
        retrying={log.isFetching}
      />
    );
  }
  return (
    <div className={styles.log}>
      {items.length === 0 ? (
        <p className={styles.empty}>{t('webhooks.deliveries.empty')}</p>
      ) : (
        <ol className={styles.deliveries} aria-label={t('webhooks.deliveries.label', { host })}>
          {items.map((d) => (
            <DeliveryRow key={d.id} delivery={d} />
          ))}
        </ol>
      )}
      {log.hasNextPage && (
        <Button
          size="sm"
          variant="ghost"
          loading={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
          className={styles.more}
        >
          {t('common.actions.loadMore')}
        </Button>
      )}
    </div>
  );
}

function DeliveryRow({ delivery: d }: { delivery: WebhookDelivery }) {
  const { t } = useI18n();
  const status = DELIVERY_STATUS[d.status];
  return (
    <li className={styles.delivery}>
      <div className={styles.deliveryHead}>
        <span className={styles.deliveryEvent}>{t(eventTypeKey(d.eventType))}</span>
        <StatusPill
          tone={status.tone}
          icon={status.icon}
          label={t(`webhooks.deliveries.status.${d.status}`)}
        />
        {d.responseStatus !== null && (
          <code className={cx(styles.code, d.responseStatus >= 300 && styles.codeFailed, 'ltr')}>
            {t('webhooks.deliveries.response', { status: d.responseStatus })}
          </code>
        )}
        <RelativeTime value={d.lastAttemptAt ?? d.createdAt} className={styles.deliveryTime} />
      </div>
      <p className={styles.deliveryMeta}>
        <span className="tabular">
          {t('webhooks.deliveries.attempts', { attempts: d.attempts, max: d.maxAttempts })}
        </span>
        {d.durationMs !== null && (
          <>
            <span aria-hidden="true"> · </span>
            <span className="tabular ltr">{d.durationMs} ms</span>
          </>
        )}
        {d.status === 'pending' && d.nextAttemptAt && (
          <>
            <span aria-hidden="true"> · </span>
            <RelativeTime
              value={d.nextAttemptAt}
              format={(time) => t('webhooks.deliveries.nextAttempt', { time })}
            />
          </>
        )}
      </p>
      {d.failureReason && (
        <p className={styles.deliveryReason}>
          {t(`webhooks.deliveries.reasons.${d.failureReason}`, {
            seconds: WEBHOOK_LIMITS.timeoutSeconds,
          })}
        </p>
      )}
      <p className={styles.deliveryId}>
        <span>{t('webhooks.deliveries.webhookId')}</span>{' '}
        <code className="ltr">{d.webhookId}</code>
      </p>
    </li>
  );
}

/* ------------------------------------------------------------------ dialogs */

function AddEndpointDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (secret: string) => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const create = useCreateWebhook();
  const urlRef = useRef<HTMLInputElement>(null);
  const eventsHintId = useId();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<WebhookEventType[]>([
    'task.completed',
    'task.failed',
    'approval.requested',
  ]);
  const [submitted, setSubmitted] = useState(false);
  const urlError = !isPlausibleWebhookUrl(url) ? t('webhooks.form.urlInvalid') : null;
  const eventsError = events.length === 0 ? t('webhooks.form.eventsRequired') : null;

  const toggle = (type: WebhookEventType) =>
    setEvents((list) =>
      list.includes(type) ? list.filter((e) => e !== type) : EVENT_TYPES.filter((e) => list.includes(e) || e === type),
    );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (urlError) {
      urlRef.current?.focus();
      return;
    }
    if (eventsError || create.isPending) return;
    create.mutate(
      {
        url: url.trim(),
        eventTypes: events,
        ...(description.trim() ? { description: description.trim() } : {}),
      },
      {
        onSuccess: ({ secret }) => {
          toast({ message: t('webhooks.toasts.created') });
          onCreated(secret);
        },
      },
    );
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!create.isPending) onClose();
      }}
      title={t('webhooks.form.title')}
      initialFocusRef={urlRef}
      dismissible={!create.isPending}
      busy={create.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>
            {t('common.actions.cancel')}
          </Button>
          <Button type="submit" form="webhook-form" variant="primary" loading={create.isPending}>
            {t('webhooks.form.create')}
          </Button>
        </>
      }
    >
      <form id="webhook-form" className={styles.form} onSubmit={submit} noValidate>
        {create.isError && <ErrorBanner error={create.error} />}
        <TextField
          ref={urlRef}
          type="url"
          inputMode="url"
          label={t('webhooks.form.url')}
          hint={t('webhooks.form.urlHint')}
          placeholder={t('webhooks.form.urlPlaceholder')}
          value={url}
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          required
          error={submitted ? urlError : undefined}
          onChange={(e) => setUrl(e.target.value)}
        />
        <TextField
          label={t('webhooks.form.description')}
          hint={t('webhooks.form.descriptionHint')}
          value={description}
          maxLength={200}
          dir={description ? 'auto' : undefined}
          onChange={(e) => setDescription(e.target.value)}
        />
        <fieldset
          className={styles.events}
          aria-describedby={submitted && eventsError ? eventsHintId : undefined}
        >
          <legend className={styles.legend}>{t('webhooks.form.eventsLegend')}</legend>
          <div className={styles.eventsTools}>
            <Button size="sm" variant="ghost" onClick={() => setEvents([...EVENT_TYPES])}>
              {t('webhooks.form.selectAll')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEvents([])}>
              {t('webhooks.form.selectNone')}
            </Button>
          </div>
          <div className={styles.eventGrid}>
            {EVENT_TYPES.map((type) => {
              const id = `event-${type}`;
              return (
                <div key={type} className={styles.event}>
                  <input
                    id={id}
                    type="checkbox"
                    className={styles.checkbox}
                    checked={events.includes(type)}
                    onChange={() => toggle(type)}
                  />
                  <label htmlFor={id}>
                    <span className={styles.eventLabel}>{t(eventTypeKey(type))}</span>
                    <code className={cx(styles.eventCode, 'ltr')}>{type}</code>
                  </label>
                </div>
              );
            })}
          </div>
          {submitted && eventsError && (
            <p id={eventsHintId} className={styles.fieldError}>
              {eventsError}
            </p>
          )}
        </fieldset>
      </form>
    </Dialog>
  );
}

/** The signing secret, once: copy it, store it, confirm. JARVIS can never show it again. */
function SecretDialog({
  secret,
  rotated,
  onClose,
}: {
  secret: string;
  rotated: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const doneRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={false}
      title={rotated ? t('webhooks.secret.rotatedTitle') : t('webhooks.secret.title')}
      description={rotated ? t('webhooks.secret.rotatedBody') : t('webhooks.secret.body')}
      initialFocusRef={doneRef}
      footer={
        <Button ref={doneRef} variant="primary" onClick={onClose}>
          {t('webhooks.secret.done')}
        </Button>
      }
    >
      <div className={styles.secretBox}>
        <p className={styles.secretLabel}>{t('webhooks.secret.label')}</p>
        <div className={styles.secretValue}>
          <code className="ltr">{secret}</code>
          <CopyButton value={secret} label={t('webhooks.secret.copy')} size="md" />
        </div>
      </div>
      <Banner tone="warning" title={t('webhooks.secret.warning')} />
    </Dialog>
  );
}
