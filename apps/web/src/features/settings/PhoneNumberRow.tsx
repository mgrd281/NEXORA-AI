'use client';

import type { Me, PhoneVerification } from '@jarvis/contracts';
import { CALL_LIMITS } from '@jarvis/contracts';
import { BadgeCheck, PhoneCall, Trash } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Banner, ErrorBanner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/i18n/I18nProvider';
import { apiErrorReason, describeError } from '@/lib/api/errors';
import { useStreamEvent } from '@/lib/events/EventStreamProvider';
import { isE164, normalizePhoneInput } from '@/features/calls/model';
import {
  useConfirmPhoneVerification,
  useCurrentPhoneVerification,
  useStartPhoneVerification,
} from '@/features/calls/api';
import { useSaveMe } from './api';
import { SaveStatus, SettingRow } from './controls';
import styles from './settings.module.css';

/**
 * Settings › Profile: the account's own phone number (E.164) — used only to put a callee through
 * to the user when a call allows it, and as the country of numbers written without one — and its
 * verification by a call that reads out a code. Personal data (exported, deleted with the account).
 */
export function PhoneNumberRow({ me }: { me: Me }) {
  const { t } = useI18n();
  const saver = useSaveMe();
  const [draft, setDraft] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const saved = me.phoneNumber ?? null;
  const value = draft ?? saved ?? '';
  const normalized = normalizePhoneInput(value);
  const invalid = value.trim() !== '' && !isE164(normalized);
  const inputRef = useRef<HTMLInputElement>(null);

  function commit() {
    if (draft === null) return;
    setTouched(true);
    if (value.trim() === '') {
      if (saved && !saver.pending) {
        saver.save({ phoneNumber: null }, { onSuccess: () => setDraft(null) });
      } else setDraft(null);
      return;
    }
    if (invalid) return;
    if (normalized === saved) {
      setDraft(null);
      return;
    }
    if (saver.pending) return;
    const sent = value;
    saver.save(
      { phoneNumber: normalized },
      { onSuccess: () => setDraft((d) => (d === sent ? null : d)) },
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid) {
      setTouched(true);
      inputRef.current?.focus();
      return;
    }
    commit();
  }

  return (
    <SettingRow>
      <form onSubmit={submit} noValidate className={styles.phoneForm}>
        <TextField
          ref={inputRef}
          label={t('settings.phone.label')}
          hint={t('settings.phone.hint')}
          error={touched && invalid ? t('settings.phone.invalid') : undefined}
          value={value}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          enterKeyHint="done"
          maxLength={32}
          // A phone number reads left to right in every interface language.
          dir="ltr"
          className={styles.phoneInput}
          onChange={(e) => {
            setDraft(e.target.value);
            if (saver.state === 'error') setTouched(false);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && draft !== null) {
              e.preventDefault();
              setDraft(null);
              setTouched(false);
            }
          }}
        />
      </form>
      <SaveStatus state={saver.state} error={saver.error} />
      {saved && (
        <div className={styles.phoneActions}>
          <Button
            size="sm"
            variant="ghost"
            icon={Trash}
            onClick={() => {
              setDraft(null);
              saver.save({ phoneNumber: null });
            }}
            disabled={saver.pending}
          >
            {t('settings.phone.remove')}
          </Button>
        </div>
      )}
      {saved && draft === null && <Verification me={me} />}
      <p className={styles.note}>{t('settings.phone.personalData')}</p>
    </SettingRow>
  );
}

function Verification({ me }: { me: Me }) {
  const { t, f } = useI18n();
  const i18n = useI18n();
  const { toast } = useToast();
  const start = useStartPhoneVerification();
  const confirm = useConfirmPhoneVerification();
  const verified = me.phoneNumberVerifiedAt ?? null;
  // Until something happens here, the verification shown is the server's (one started before a
  // reload or before leaving Settings); afterwards, what this screen started or learned.
  const current = useCurrentPhoneVerification(!verified);
  const [local, setVerification] = useState<PhoneVerification | null | undefined>(undefined);
  const verification = local === undefined ? (current.data?.verification ?? null) : local;
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const codeId = useId();

  // The verification call's own state (failed, expired) arrives on the stream.
  useStreamEvent(
    (event) => {
      const id = event.data.verificationId;
      const status = event.data.status;
      if (!verification || id !== verification.id || typeof status !== 'string') return;
      if (
        status === 'calling' ||
        status === 'pending' ||
        status === 'verified' ||
        status === 'expired' ||
        status === 'failed'
      ) {
        setVerification({ ...verification, status });
      }
    },
    ['phone_verification.changed'],
  );

  if (verified) {
    return (
      <div className={styles.verification}>
        <Badge tone="success" icon={BadgeCheck}>
          {t('settings.phone.verified', { date: f.date(verified) })}
        </Badge>
        <p className={styles.note}>{t('settings.phone.verifiedNote')}</p>
      </div>
    );
  }

  const codeValid = new RegExp(`^\\d{${CALL_LIMITS.verificationCodeLength}}$`).test(code.trim());
  const live =
    verification && (verification.status === 'calling' || verification.status === 'pending');
  const notConfigured = apiErrorReason(start.error) === 'TELEPHONY_NOT_CONFIGURED';

  return (
    <div className={styles.verification}>
      <div className={styles.verificationHead}>
        <Badge>{t('settings.phone.notVerified')}</Badge>
        <p className={styles.note}>{t('settings.phone.notVerifiedNote')}</p>
      </div>
      {!live && (
        <div>
          <Button
            size="sm"
            icon={PhoneCall}
            loading={start.isPending}
            onClick={() => {
              confirm.reset();
              setCode('');
              setCodeTouched(false);
              start.mutate(undefined, { onSuccess: (v) => setVerification(v) });
            }}
          >
            {t('settings.phone.verify')}
          </Button>
        </div>
      )}
      {verification?.status === 'failed' && (
        <Banner tone="warning" live title={t('settings.phone.failed')} />
      )}
      {verification?.status === 'expired' && (
        <Banner tone="warning" live title={t('settings.phone.expired')} />
      )}
      {notConfigured ? (
        <Banner tone="info" title={t('settings.phone.notConfigured')} />
      ) : start.isError ? (
        <ErrorBanner error={start.error} />
      ) : null}
      {live && verification && (
        <form
          className={styles.codeForm}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setCodeTouched(true);
            if (!codeValid) return;
            confirm.mutate(code.trim(), {
              onSuccess: () => {
                setVerification(null);
                toast({ message: t('settings.phone.verifiedNow') });
              },
              onError: (err) => {
                const left = err.details?.attemptsLeft;
                if (typeof left === 'number')
                  setVerification({ ...verification, attemptsLeft: left });
                if (apiErrorReason(err) === 'PHONE_VERIFICATION_EXPIRED')
                  setVerification({ ...verification, status: 'expired' });
              },
            });
          }}
        >
          <p className={styles.rowText} role="status">
            {t('settings.phone.calling', {
              number: `⁦${verification.number}⁩`,
              length: CALL_LIMITS.verificationCodeLength,
            })}
          </p>
          <TextField
            id={codeId}
            label={t('settings.phone.code')}
            hint={t('settings.phone.codeHint', {
              attempts: verification.attemptsLeft,
              time: f.time(verification.expiresAt),
            })}
            error={
              confirm.isError
                ? describeError(confirm.error, i18n).message
                : codeTouched && !codeValid
                  ? t('settings.phone.codeInvalid', { length: CALL_LIMITS.verificationCodeLength })
                  : undefined
            }
            value={code}
            onChange={(e) => {
              setCode(
                e.target.value.replace(/\D/g, '').slice(0, CALL_LIMITS.verificationCodeLength),
              );
              if (confirm.isError) confirm.reset();
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={CALL_LIMITS.verificationCodeLength}
            dir="ltr"
            className={styles.codeInput}
          />
          <div className={styles.codeActions}>
            <Button type="submit" size="sm" variant="primary" loading={confirm.isPending}>
              {t('settings.phone.confirm')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setVerification(null)}>
              {t('settings.phone.cancel')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
