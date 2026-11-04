'use client';

import type {
  Connection,
  ConnectionCapability,
  ConnectionProviderInfo,
  OAuthProvider,
} from '@jarvis/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CirclePause, ExternalLink, Mail, RotateCcw } from 'lucide-react';
import { useEffect, useId, useRef, useState, type Ref } from 'react';
import { Banner, ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/i18n/I18nProvider';
import { CAPABILITY_LABEL, PROVIDER_NAME } from '@/i18n/server-message';
import type { MessageKey } from '@/i18n/catalog';
import { api, type ApiError } from '@/lib/api/client';
import { cx } from '@/lib/cx';
import { forgetConnection, useStartOAuth } from './api';
import { ConnectionCard } from './ConnectionCard';
import {
  CAPABILITY_GROUPS,
  DEFAULT_CAPABILITIES,
  missingCapabilities,
  oauthCardState,
  offeredCapabilities,
  reconnectCapabilities,
  requiredBy,
  scopesFor,
  withPrerequisites,
} from './oauth';
import styles from './connections.module.css';

/** "mail.read" → "connections.oauth.hints.mailRead". */
const HINT: Record<ConnectionCapability, MessageKey> = {
  'mail.read': 'connections.oauth.hints.mailRead',
  'mail.compose': 'connections.oauth.hints.mailCompose',
  'mail.send': 'connections.oauth.hints.mailSend',
  'calendar.read': 'connections.oauth.hints.calendarRead',
  'calendar.write': 'connections.oauth.hints.calendarWrite',
};

const MARK: Record<OAuthProvider, string> = { google: 'G', microsoft: 'M' };

/** Where Microsoft users remove an app's consent themselves (there is no revoke endpoint). */
const MICROSOFT_CONSENT_PAGES = {
  personal: 'https://account.live.com/consent/Manage',
  work: 'https://myapps.microsoft.com',
} as const;

/**
 * One Google or Microsoft account: what JARVIS may do with it (each capability in plain words,
 * the exact scopes behind a disclosure), its account and health, and the one action its state
 * needs — connect, allow more, reconnect when expired, or disconnect (with what that revokes).
 * A provider this server has no client for says so instead of offering a dead button.
 */
export function OAuthCard({
  info,
  connection,
}: {
  info: ConnectionProviderInfo;
  connection: Connection | null;
}) {
  const { t } = useI18n();
  const provider = info.provider as OAuthProvider;
  const name = PROVIDER_NAME[provider];
  const state = oauthCardState(info, connection);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusPending = useRef(false);
  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    headingRef.current?.focus();
  }, [connection]);

  const status =
    state === 'unconfigured'
      ? 'unconfigured'
      : state === 'disconnected'
        ? null
        : (connection?.status ?? null);

  return (
    <ConnectionCard
      ref={headingRef}
      icon={Mail}
      mark={MARK[provider]}
      title={name}
      summary={t(`connections.oauth.providers.${provider}.summary`)}
      status={status}
      muted={state === 'unconfigured'}
      footer={
        connection && state !== 'unconfigured' ? (
          <ConnectedFooter
            connection={connection}
            info={info}
            onDisconnected={() => {
              focusPending.current = true;
            }}
          />
        ) : undefined
      }
    >
      {state === 'unconfigured' ? (
        <p className={styles.hint}>
          <span className={styles.notConfigured}>{t('connections.oauth.notConfigured')}</span>{' '}
          {t('connections.oauth.notConfiguredBody', { provider: name })}
        </p>
      ) : !connection ? (
        <ConnectForm info={info} />
      ) : (
        <ConnectedBody info={info} connection={connection} state={state} />
      )}
    </ConnectionCard>
  );
}

/* ------------------------------------------------------------------ connect */

function ConnectForm({ info }: { info: ConnectionProviderInfo }) {
  const { t } = useI18n();
  const provider = info.provider as OAuthProvider;
  const name = PROVIDER_NAME[provider];
  const offered = offeredCapabilities(info);
  const [selected, setSelected] = useState<ConnectionCapability[]>(() =>
    DEFAULT_CAPABILITIES.filter((c) => offered.includes(c)),
  );
  const [tried, setTried] = useState(false);
  const start = useStartOAuth();
  const errorId = useId();
  const groupRef = useRef<HTMLFieldSetElement>(null);
  const capabilities = withPrerequisites(selected, offered);
  const empty = capabilities.length === 0;

  function connect() {
    setTried(true);
    if (empty) {
      groupRef.current?.querySelector<HTMLInputElement>('input')?.focus();
      return;
    }
    start.reset();
    start.mutate({ provider, capabilities, returnTo: '/connections' });
  }

  return (
    <div className={styles.oauthBody}>
      <CapabilityPicker
        ref={groupRef}
        offered={offered}
        selected={selected}
        onChange={setSelected}
        legend={t('connections.oauth.chooseTitle')}
        hint={t('connections.oauth.chooseHint')}
        errorId={tried && empty ? errorId : undefined}
      />
      {tried && empty && (
        <p id={errorId} className={styles.fieldError} role="alert">
          {t('connections.oauth.noneSelected')}
        </p>
      )}
      <ScopeList info={info} capabilities={capabilities} granted={false} />
      {start.isError && <ErrorBanner error={start.error} />}
      <div className={styles.oauthActions}>
        <p className={styles.hint}>{t('connections.oauth.connectHint', { provider: name })}</p>
        <Button
          variant="primary"
          icon={ExternalLink}
          loading={start.isPending || start.isSuccess}
          onClick={connect}
        >
          {t('connections.oauth.connect', { provider: name })}
        </Button>
      </div>
    </div>
  );
}

/** Checkbox rows per group (Email, Calendar); a prerequisite stays checked and says why. */
function CapabilityPicker({
  ref,
  offered,
  selected,
  onChange,
  legend,
  hint,
  errorId,
  only,
}: {
  ref?: Ref<HTMLFieldSetElement>;
  offered: readonly ConnectionCapability[];
  selected: readonly ConnectionCapability[];
  onChange: (next: ConnectionCapability[]) => void;
  legend: string;
  hint?: string;
  errorId?: string;
  /** Only these capabilities (e.g. the ones not granted yet). */
  only?: readonly ConnectionCapability[];
}) {
  const { t } = useI18n();
  const hintId = useId();
  const shown = (c: ConnectionCapability) => offered.includes(c) && (!only || only.includes(c));
  const groups = CAPABILITY_GROUPS.map((g) => ({
    ...g,
    capabilities: g.capabilities.filter(shown),
  })).filter((g) => g.capabilities.length > 0);
  const effective = withPrerequisites(selected, offered);
  return (
    <fieldset
      ref={ref}
      className={styles.picker}
      aria-describedby={[hint ? hintId : null, errorId].filter(Boolean).join(' ') || undefined}
    >
      <legend className={styles.subTitle}>{legend}</legend>
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      <div className={styles.groups}>
        {groups.map((g) => (
          <div
            key={g.group}
            className={styles.group}
            role="group"
            aria-labelledby={`${hintId}-${g.group}`}
          >
            <p id={`${hintId}-${g.group}`} className={styles.groupTitle}>
              {t(`connections.oauth.groups.${g.group}`)}
            </p>
            <ul className={styles.options}>
              {g.capabilities.map((c) => {
                const lockedBy = requiredBy(c, selected);
                const checked = effective.includes(c);
                return (
                  <li key={c}>
                    <label className={cx(styles.option, lockedBy && styles.optionLocked)}>
                      <input
                        type="checkbox"
                        className={styles.checkbox}
                        checked={checked}
                        disabled={lockedBy !== null}
                        aria-describedby={`${hintId}-${c}`}
                        onChange={(e) =>
                          onChange(
                            e.target.checked ? [...selected, c] : selected.filter((x) => x !== c),
                          )
                        }
                      />
                      <span className={styles.optionText}>
                        <span className={styles.optionLabel}>{t(CAPABILITY_LABEL[c])}</span>
                        <span id={`${hintId}-${c}`} className={styles.optionHint}>
                          {lockedBy
                            ? t('connections.oauth.requiredBy', {
                                capability: t(CAPABILITY_LABEL[lockedBy]),
                              })
                            : t(HINT[c])}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

/** The exact provider scopes (requested, or granted) behind a disclosure, in mono and LTR. */
function ScopeList({
  info,
  capabilities,
  granted,
  scopes,
}: {
  info: ConnectionProviderInfo;
  capabilities: readonly ConnectionCapability[];
  granted: boolean;
  /** The scopes the provider granted (Connection.scopes); default: what `capabilities` asks for. */
  scopes?: readonly string[];
}) {
  const { t } = useI18n();
  const name = PROVIDER_NAME[info.provider];
  const list = scopes ?? scopesFor(info, capabilities);
  if (list.length === 0) return null;
  return (
    <details className={styles.scopes}>
      <summary>
        {granted
          ? t('connections.oauth.scopesGrantedToggle', { provider: name })
          : t('connections.oauth.scopesToggle', { provider: name })}
      </summary>
      <ul className={styles.scopeList}>
        {list.map((scope) => (
          <li key={scope}>
            <code className="ltr">{scope}</code>
          </li>
        ))}
      </ul>
      {!granted && <p className={styles.hint}>{t('connections.oauth.scopesIdentity')}</p>}
    </details>
  );
}

/* ------------------------------------------------------------------ connected */

function ConnectedBody({
  info,
  connection,
  state,
}: {
  info: ConnectionProviderInfo;
  connection: Connection;
  state: ReturnType<typeof oauthCardState>;
}) {
  const { t, f } = useI18n();
  const provider = info.provider as OAuthProvider;
  const name = PROVIDER_NAME[provider];
  const listId = useId();
  const granted = (connection.capabilities ?? []).filter((c) =>
    offeredCapabilities(info).includes(c),
  );
  const missing = missingCapabilities(info, connection);
  const reconnectWith = reconnectCapabilities(info, connection);
  const reconnect = useStartOAuth();

  return (
    <div className={styles.oauthBody}>
      {state === 'expired' && (
        <Banner
          tone="warning"
          title={t('connections.oauth.expired.title', { provider: name })}
          action={
            <Button
              variant="primary"
              icon={RotateCcw}
              loading={reconnect.isPending || reconnect.isSuccess}
              aria-label={t('connections.oauth.expired.reconnectLabel', { provider: name })}
              onClick={() =>
                reconnect.mutate({
                  provider,
                  capabilities: reconnectWith,
                  connectionId: connection.id,
                  returnTo: '/connections',
                })
              }
            >
              {t('connections.oauth.expired.reconnect')}
            </Button>
          }
        >
          <p>
            {connection.statusReason === 'GRANT_INVALID' ||
            connection.statusReason === 'TOKEN_REJECTED'
              ? t(`connections.oauth.expired.${connection.statusReason}`, { provider: name })
              : t('connections.oauth.expired.generic')}
          </p>
          <p>
            {t('connections.oauth.expired.asksFor', {
              list: f.list(reconnectWith.map((c) => t(CAPABILITY_LABEL[c]))),
            })}
          </p>
        </Banner>
      )}
      {reconnect.isError && <ErrorBanner error={reconnect.error} />}
      {state === 'scopeMissing' && (
        <Banner
          tone="warning"
          title={t('connections.oauth.scopeMissing.title', { provider: name })}
        >
          <p>{t('connections.oauth.scopeMissing.body')}</p>
        </Banner>
      )}
      {state === 'error' && (
        <Banner tone="warning" title={t('connections.oauth.error.title', { provider: name })}>
          <p>{t('connections.oauth.error.body')}</p>
        </Banner>
      )}

      <dl className={styles.details}>
        <div>
          <dt>{t('connections.oauth.account')}</dt>
          <dd>
            <span className="ltr">{connection.accountIdentifier ?? connection.label}</span>
          </dd>
        </div>
      </dl>

      {granted.length > 0 && (
        <div className={styles.canDo}>
          <h3 id={listId} className={styles.subTitle}>
            {state === 'expired'
              ? t('connections.oauth.pausedTitle')
              : t('connections.oauth.canDoTitle')}
          </h3>
          <div className={styles.grantGroups} aria-labelledby={listId} role="group">
            {CAPABILITY_GROUPS.map((g) => {
              const items = g.capabilities.filter((c) => granted.includes(c));
              if (items.length === 0) return null;
              return (
                <div key={g.group} className={styles.grantGroup}>
                  <p className={styles.groupTitle}>{t(`connections.oauth.groups.${g.group}`)}</p>
                  <ul className={styles.grantList}>
                    {items.map((c) => (
                      <li
                        key={c}
                        title={t(HINT[c])}
                        className={cx(state === 'expired' && styles.grantPaused)}
                      >
                        <Icon icon={state === 'expired' ? CirclePause : Check} size={16} />
                        <span>{t(CAPABILITY_LABEL[c])}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
          <ScopeList
            info={info}
            capabilities={granted}
            granted
            scopes={
              connection.scopes && connection.scopes.length > 0 ? connection.scopes : undefined
            }
          />
        </div>
      )}

      {state !== 'expired' && missing.length > 0 && (
        <AllowMore info={info} connection={connection} missing={missing} />
      )}
      <p className={styles.hint}>
        {info.revocation === 'local_only'
          ? t('connections.oauth.revocation.local_only')
          : t('connections.oauth.revocation.provider', { provider: name })}
      </p>
    </div>
  );
}

/** Incremental authorization: only the capabilities chosen here are requested. */
function AllowMore({
  info,
  connection,
  missing,
}: {
  info: ConnectionProviderInfo;
  connection: Connection;
  missing: readonly ConnectionCapability[];
}) {
  const { t } = useI18n();
  const provider = info.provider as OAuthProvider;
  const name = PROVIDER_NAME[provider];
  const [selected, setSelected] = useState<ConnectionCapability[]>([]);
  const add = useStartOAuth();
  const offered = offeredCapabilities(info);
  const granted = connection.capabilities ?? [];
  // A prerequisite already granted needs no new consent.
  const asked = withPrerequisites(selected, offered).filter((c) => !granted.includes(c));
  return (
    <div className={styles.allowMore}>
      <CapabilityPicker
        offered={offered}
        only={missing}
        selected={[...granted, ...selected]}
        onChange={(next) => setSelected(next.filter((c) => !granted.includes(c)))}
        legend={t('connections.oauth.addTitle')}
        hint={t('connections.oauth.addHint', { provider: name })}
      />
      {asked.length > 0 && <ScopeList info={info} capabilities={asked} granted={false} />}
      {add.isError && <ErrorBanner error={add.error} />}
      <div className={styles.oauthActions}>
        <Button
          icon={ExternalLink}
          disabled={asked.length === 0}
          loading={add.isPending || add.isSuccess}
          onClick={() =>
            add.mutate({
              provider,
              capabilities: asked,
              connectionId: connection.id,
              returnTo: '/connections',
            })
          }
        >
          {t('connections.oauth.add', { provider: name })}
        </Button>
      </div>
    </div>
  );
}

function ConnectedFooter({
  connection,
  info,
  onDisconnected,
}: {
  connection: Connection;
  info: ConnectionProviderInfo;
  onDisconnected: () => void;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <span className={styles.meta}>
        <RelativeTime
          value={connection.createdAt}
          format={(time) => t('connections.oauth.connected', { time })}
        />
        {connection.lastVerifiedAt && (
          <>
            <span aria-hidden="true"> · </span>
            <RelativeTime
              value={connection.lastVerifiedAt}
              format={(time) => t('connections.oauth.lastChecked', { time })}
            />
          </>
        )}
      </span>
      <div className={styles.actions}>
        <Button variant="danger" onClick={() => setConfirming(true)}>
          {t('connections.oauth.disconnect')}
        </Button>
      </div>
      {confirming && (
        <DisconnectDialog
          connection={connection}
          info={info}
          onClose={() => setConfirming(false)}
          onDisconnected={onDisconnected}
        />
      )}
    </>
  );
}

function DisconnectDialog({
  connection,
  info,
  onClose,
  onDisconnected,
}: {
  connection: Connection;
  info: ConnectionProviderInfo;
  onClose: () => void;
  onDisconnected: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const name = PROVIDER_NAME[info.provider];
  const remove = useMutation<void, ApiError>({
    mutationFn: () => api.call('deleteConnection', { params: { id: connection.id } }),
    onSuccess: () => {
      forgetConnection(queryClient, connection.id);
      toast({ message: t('connections.oauth.disconnected', { provider: name }) });
      onDisconnected();
    },
  });
  const mail = (connection.capabilities ?? []).some((c) => c.startsWith('mail.'));
  return (
    <Dialog
      open
      size="sm"
      onClose={() => {
        if (!remove.isPending) onClose();
      }}
      title={t('connections.oauth.disconnectDialog.title', { provider: name })}
      busy={remove.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={remove.isPending}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="destructive" loading={remove.isPending} onClick={() => remove.mutate()}>
            {t('connections.oauth.disconnectDialog.confirm')}
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <p className={styles.dialogLead}>
          {t('connections.oauth.disconnectDialog.body', {
            account: '⁨' + (connection.accountIdentifier ?? name) + '⁩',
          })}
        </p>
        {info.revocation === 'local_only' ? (
          <>
            <p className={styles.hint}>{t('connections.oauth.disconnectDialog.local_only')}</p>
            <ul className={styles.consentLinks}>
              <li>
                <span>{t('connections.oauth.disconnectDialog.localOnlyPersonal')}</span>
                <ExternalHref href={MICROSOFT_CONSENT_PAGES.personal} />
              </li>
              <li>
                <span>{t('connections.oauth.disconnectDialog.localOnlyWork')}</span>
                <ExternalHref href={MICROSOFT_CONSENT_PAGES.work} />
              </li>
            </ul>
          </>
        ) : (
          <p className={styles.hint}>
            {t('connections.oauth.disconnectDialog.provider', { provider: name })}
          </p>
        )}
        {mail && <p className={styles.hint}>{t('connections.oauth.disconnectDialog.watches')}</p>}
        {remove.isError && <ErrorBanner error={remove.error} />}
      </div>
    </Dialog>
  );
}

function ExternalHref({ href }: { href: string }) {
  const { t } = useI18n();
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cx('ltr', styles.extLink)}>
      {href.replace(/^https:\/\//, '')}
      <Icon icon={ExternalLink} size={16} />
      <span className="visually-hidden"> {t('tasks.evidence.opensInNewTab')}</span>
    </a>
  );
}
