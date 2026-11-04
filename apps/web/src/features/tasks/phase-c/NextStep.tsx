'use client';

import type { TaskDetail, TaskError } from '@jarvis/contracts';
import { ConnectionCapability, OAuthProvider } from '@jarvis/contracts';
import { ExternalLink, PhoneOff, Wallet } from 'lucide-react';
import { ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useI18n } from '@/i18n/I18nProvider';
import { CAPABILITY_LABEL, PROVIDER_NAME } from '@/i18n/server-message';
import { ReconnectButton } from '@/features/connections/Reconnect';
import { safeExternalUrl } from '../model';
import { cartView, handoverOf, succeeded } from './results';
import styles from './NextStep.module.css';

export type NextStepKind =
  | 'reconnect'
  | 'allow'
  | 'handover'
  | 'unsupported'
  | 'limit'
  | 'currency'
  | 'cart'
  | 'unknownOrder'
  | 'unconfirmedBooking'
  // Phase D: phone calls
  | 'callRetry'
  | 'callUnknown'
  | 'doNotCall'
  | 'callHours'
  | 'callDeclined'
  | 'callRecording';

/** The failure has one specific next step (Phase C), or null for the generic guidance. */
export function hasNextStep(
  error: Pick<TaskError, 'reason' | 'params'> | null,
): NextStepKind | null {
  switch (error?.reason) {
    case 'CONNECTION_EXPIRED':
      return OAuthProvider.safeParse(error.params?.provider).success ? 'reconnect' : null;
    case 'CONNECTION_SCOPE_MISSING':
      return OAuthProvider.safeParse(error.params?.provider).success &&
        ConnectionCapability.safeParse(error.params?.capability).success
        ? 'allow'
        : null;
    case 'CAPTCHA_DETECTED':
    case 'LOGIN_REQUIRED':
    case 'BOT_PROTECTION':
      return 'handover';
    case 'SITE_UNSUPPORTED':
      return 'unsupported';
    case 'PURCHASES_DISABLED':
    case 'PURCHASE_LIMIT':
      return 'limit';
    case 'PURCHASE_CURRENCY':
      return 'currency';
    case 'CHECKOUT_UNSUPPORTED':
      return 'cart';
    case 'ORDER_UNKNOWN':
      return 'unknownOrder';
    case 'BOOKING_UNCONFIRMED':
      return 'unconfirmedBooking';
    // Phase D: an unsuccessful call (scenario 4) — nothing was said or agreed.
    case 'CALL_BUSY':
    case 'CALL_NO_ANSWER':
    case 'CALL_VOICEMAIL':
    case 'CALL_HUNG_UP':
    case 'CALL_FAILED':
    case 'CALL_DURATION_LIMIT':
      return 'callRetry';
    case 'CALL_STATE_UNKNOWN':
      return 'callUnknown';
    case 'DO_NOT_CALL':
      return 'doNotCall';
    case 'CALL_OUTSIDE_HOURS':
      return 'callHours';
    case 'CALL_DECLINED':
      return 'callDeclined';
    case 'RECORDING_CONSENT_DECLINED':
      return 'callRecording';
    default:
      return null;
  }
}

/**
 * The next step of a Phase C failure, in the failed-task banner: Reconnect (then Retry — the
 * callback page offers it), allow the missing permission, open the site yourself after a
 * CAPTCHA / sign-in / bot wall (JARVIS never gets around those), adjust the purchase limit, or
 * finish at the shop. Each says what happens, and its button does exactly that.
 */
export function NextStep({ task }: { task: TaskDetail }) {
  const { t } = useI18n();
  const error = task.error;
  const kind = hasNextStep(error);
  if (!error || !kind) return null;
  const returnTo = `/tasks/${task.id}`;
  const params = error.params ?? {};
  switch (kind) {
    case 'reconnect': {
      const provider = OAuthProvider.parse(params.provider);
      return (
        <div className={styles.step}>
          <p>{t('tasks.nextStep.reconnect', { provider: PROVIDER_NAME[provider] })}</p>
          <div className={styles.actions}>
            <ReconnectButton provider={provider} returnTo={returnTo} size="sm" />
          </div>
        </div>
      );
    }
    case 'allow': {
      const provider = OAuthProvider.parse(params.provider);
      const capability = ConnectionCapability.parse(params.capability);
      return (
        <div className={styles.step}>
          <p>
            {t('tasks.nextStep.allow', {
              provider: PROVIDER_NAME[provider],
              capability: t(CAPABILITY_LABEL[capability]),
            })}
          </p>
          <div className={styles.actions}>
            <ReconnectButton
              provider={provider}
              capability={capability}
              returnTo={returnTo}
              size="sm"
            />
          </div>
        </div>
      );
    }
    case 'handover': {
      const handover = handoverOf(task.browserSessions)?.url ?? handoverFromEvidence(task);
      const reason = error.reason as 'CAPTCHA_DETECTED' | 'LOGIN_REQUIRED' | 'BOT_PROTECTION';
      // The reason already says what happened; with the site's address the button is the step.
      return (
        <div className={styles.step}>
          {handover ? (
            <div className={styles.actions}>
              <a
                href={handover}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.externalButton}
              >
                {t('tasks.phaseC.openSite')}
                <Icon icon={ExternalLink} size={16} />
                <span className="visually-hidden"> {t('tasks.evidence.opensInNewTab')}</span>
              </a>
            </div>
          ) : (
            <p>{t(`tasks.nextStep.handover.${reason}`)}</p>
          )}
        </div>
      );
    }
    case 'unsupported':
      return (
        <div className={styles.step}>
          <p>{t('tasks.nextStep.unsupported')}</p>
        </div>
      );
    case 'limit':
      return (
        <div className={styles.step}>
          <p>
            {error.reason === 'PURCHASES_DISABLED'
              ? t('tasks.nextStep.limitOff')
              : t('tasks.nextStep.limitOver')}
          </p>
          <div className={styles.actions}>
            <ButtonLink href="/settings#spending" size="sm" icon={Wallet}>
              {error.reason === 'PURCHASES_DISABLED'
                ? t('tasks.nextStep.setLimit')
                : t('tasks.nextStep.adjustLimit')}
            </ButtonLink>
          </div>
        </div>
      );
    case 'currency':
      return (
        <div className={styles.step}>
          <p>{t('tasks.nextStep.currency')}</p>
        </div>
      );
    case 'cart': {
      const cart = cartView(succeeded(task.steps, 'shop.prepare_cart'));
      return (
        <div className={styles.step}>
          <p>{t('tasks.nextStep.cart')}</p>
          {cart?.handoverUrl && (
            <div className={styles.actions}>
              <a
                href={cart.handoverUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.externalButton}
              >
                {t('tasks.phaseC.cart.openCart')}
                <Icon icon={ExternalLink} size={16} />
                <span className="visually-hidden"> {t('tasks.evidence.opensInNewTab')}</span>
              </a>
            </div>
          )}
        </div>
      );
    }
    case 'unknownOrder':
      return (
        <div className={styles.step}>
          <p>{t('tasks.nextStep.unknownOrder')}</p>
          <div className={styles.actions}>
            <ButtonLink href="/settings#spending" size="sm" icon={Wallet}>
              {t('tasks.nextStep.viewOrders')}
            </ButtonLink>
          </div>
        </div>
      );
    case 'unconfirmedBooking':
      return (
        <div className={styles.step}>
          <p>{t('tasks.nextStep.unconfirmedBooking')}</p>
        </div>
      );
    case 'doNotCall':
      return (
        <div className={styles.step}>
          <p>{t('tasks.nextStep.doNotCall')}</p>
          <div className={styles.actions}>
            <ButtonLink href="/settings#privacy" size="sm" icon={PhoneOff}>
              {t('tasks.nextStep.manageDoNotCall')}
            </ButtonLink>
          </div>
        </div>
      );
    case 'callRetry':
    case 'callUnknown':
    case 'callHours':
    case 'callDeclined':
    case 'callRecording':
      // The header's Retry places a new call (OUTCOME_UNKNOWN asks to acknowledge first).
      return (
        <div className={styles.step}>
          <p>{t(`tasks.nextStep.${kind}`)}</p>
        </div>
      );
  }
}

/** A HANDOVER evidence record of a failed step ({ host, reason, url }), as a safe link. */
function handoverFromEvidence(task: TaskDetail): string | null {
  for (const step of task.steps) {
    for (const e of step.evidence) {
      if (e.code === 'HANDOVER') {
        const url = safeExternalUrl(typeof e.params?.url === 'string' ? e.params.url : null);
        if (url) return url;
      }
    }
  }
  return null;
}
