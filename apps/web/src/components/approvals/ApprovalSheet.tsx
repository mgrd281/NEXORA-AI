'use client';

import type { Approval, ApprovalDecisionRequest } from '@jarvis/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Banner, ErrorBanner } from '@/components/ui/Banner';
import { RiskBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { TextArea } from '@/components/ui/Field';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Sheet } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/i18n/I18nProvider';
import { api, isApiError, newIdempotencyKey } from '@/lib/api/client';
import { useApprovals } from '@/lib/api/hooks';
import { qk } from '@/lib/api/query-keys';
import { useNow } from '@/lib/hooks/useNow';
import styles from './ApprovalSheet.module.css';

type Notice = 'mismatch' | 'expired' | 'alreadyDecided' | null;

export interface ApprovalSheetProps {
  /** The approval to review (from Home, the task, or the approvals list). */
  approval: Approval | null;
  open: boolean;
  onClose: () => void;
  onDecided?: (approval: Approval) => void;
  /** Hide the "Open task" link (when already on the task screen). */
  hideTaskLink?: boolean;
}

/**
 * Shows exactly what will happen before JARVIS does it: for email the sender, every
 * recipient, the subject and the full body; the risk and the policy reasons in plain language;
 * when it expires. Approve / Decline post the decision bound to the approval's actionHash, so a
 * changed action is refused (APPROVAL_MISMATCH) and shown again instead of being approved.
 */
export function ApprovalSheet({
  approval,
  open,
  onClose,
  onDecided,
  hideTaskLink,
}: ApprovalSheetProps) {
  const { t } = useI18n();
  const isEmail = approval?.details.kind === 'email';
  return (
    <Sheet
      open={open && approval !== null}
      onClose={onClose}
      title={isEmail ? t('approvals.title.email') : t('approvals.title.generic')}
      placement="side"
    >
      {open && approval && (
        <ApprovalReview
          key={approval.id}
          approval={approval}
          onClose={onClose}
          onDecided={onDecided}
          hideTaskLink={hideTaskLink}
        />
      )}
    </Sheet>
  );
}

function ApprovalReview({
  approval: initial,
  onClose,
  onDecided,
  hideTaskLink,
}: {
  approval: Approval;
  onClose: () => void;
  onDecided?: (approval: Approval) => void;
  hideTaskLink?: boolean;
}) {
  const { t, tDynamic } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const pending = useApprovals();
  const now = useNow();
  const [decided, setDecided] = useState<Approval | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const keys = useRef(new Map<string, string>());

  // Prefer the freshest server copy (after a mismatch it carries the stored action and hash).
  const fresh = pending.data?.items.find((a) => a.id === initial.id);
  const approval = decided ?? fresh ?? initial;
  const isEmail = approval.details.kind === 'email';
  // The pending list no longer contains it: decided elsewhere, expired or replaced.
  const noLongerPending = pending.isSuccess && !fresh && !decided;
  const actionChanged = approval.actionHash !== initial.actionHash;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.approvals });
    void queryClient.invalidateQueries({ queryKey: qk.home });
    void queryClient.invalidateQueries({ queryKey: qk.tasks.detail(approval.taskId) });
    void queryClient.invalidateQueries({ queryKey: qk.tasks.lists });
  };

  const decide = useMutation({
    mutationFn: (decision: ApprovalDecisionRequest['decision']) => {
      const keyId = `${approval.id}:${approval.actionHash}:${decision}`;
      let key = keys.current.get(keyId);
      if (!key) {
        key = newIdempotencyKey();
        keys.current.set(keyId, key);
      }
      const trimmed = note.trim();
      return api.call('decideApproval', {
        params: { id: approval.id },
        body: { decision, actionHash: approval.actionHash, ...(trimmed ? { note: trimmed } : {}) },
        idempotencyKey: key,
      });
    },
    onSuccess: (result) => {
      setDecided(result);
      refresh();
      toast({
        message:
          result.status === 'APPROVED'
            ? t('approvals.results.approved')
            : t('approvals.results.rejected'),
      });
      onDecided?.(result);
      onClose();
    },
    onError: (err) => {
      if (isApiError(err, 'APPROVAL_MISMATCH')) setNotice('mismatch');
      else if (isApiError(err, 'APPROVAL_EXPIRED')) setNotice('expired');
      else if (isApiError(err, 'INVALID_STATE')) setNotice('alreadyDecided');
      else return;
      // These are expected outcomes: reload the approval and show what changed.
      decide.reset();
      refresh();
    },
  });

  const expired =
    approval.status === 'EXPIRED' || (now !== 0 && new Date(approval.expiresAt).getTime() <= now);
  const isPending =
    approval.status === 'PENDING' && !expired && notice !== 'alreadyDecided' && !noLongerPending;
  const deciding = decide.isPending ? decide.variables : null;
  const untrusted = approval.reasons.includes('UNTRUSTED_CONTENT');

  return (
    <div className={styles.review} aria-busy={deciding ? true : undefined}>
      <p className={styles.summary} dir="auto">
        {approval.summary}
      </p>

      <div className={styles.meta}>
        <RiskBadge level={approval.riskLevel} label={t(`common.risk.${approval.riskLevel}`)} />
        {approval.status === 'PENDING' && (
          <RelativeTime
            value={approval.expiresAt}
            className={styles.expires}
            format={(time) => t('approvals.expires', { time })}
          />
        )}
        {!hideTaskLink && (
          <Link href={`/tasks/${approval.taskId}`} className={styles.taskLink} onClick={onClose}>
            <span className="visually-hidden">{t('approvals.task')}: </span>
            <span dir="auto">{approval.taskTitle}</span>
          </Link>
        )}
      </div>

      {(notice === 'mismatch' || actionChanged) && (
        <Banner tone="warning" live title={t('approvals.errors.mismatch')} />
      )}
      {(notice === 'expired' || (expired && approval.status === 'PENDING')) && (
        <Banner tone="warning" live title={t('approvals.errors.expired')} />
      )}
      {(notice === 'alreadyDecided' ||
        (noLongerPending && approval.status === 'PENDING' && !expired && notice !== 'expired')) && (
        <Banner tone="info" live title={t('approvals.errors.alreadyDecided')} />
      )}
      {untrusted && <Banner tone="warning" title={t('approvals.untrustedWarning')} />}
      {approval.status !== 'PENDING' && <DecidedNote approval={approval} />}

      {approval.details.kind === 'email' ? (
        <div className={styles.email}>
          <dl className={styles.fields}>
            <div className={styles.fieldRow}>
              <dt>{t('approvals.fields.from')}</dt>
              <dd>
                <span className="ltr">{approval.details.from}</span>
              </dd>
            </div>
            <div className={styles.fieldRow}>
              <dt>
                {t('approvals.fields.to')}
                <span className="visually-hidden">
                  {' '}
                  ({t('approvals.recipients', { count: approval.details.to.length })})
                </span>
              </dt>
              <dd>
                <ul className={styles.recipients}>
                  {approval.details.to.map((address) => (
                    <li key={address} className={styles.recipient}>
                      <span className="ltr">{address}</span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
            <div className={styles.fieldRow}>
              <dt>{t('approvals.fields.subject')}</dt>
              <dd dir="auto" className={styles.subject}>
                {approval.details.subject || t('approvals.fields.noSubject')}
              </dd>
            </div>
          </dl>
          <div className={styles.bodyBlock}>
            <p className={styles.bodyLabel}>{t('approvals.fields.body')}</p>
            {/* Scrollable, so it must be reachable by keyboard (WCAG 2.1.1). */}
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
            <pre className={styles.body} dir="auto" tabIndex={0}>
              {approval.details.body}
            </pre>
          </div>
        </div>
      ) : (
        <dl className={styles.fields}>
          {approval.details.fields.map((field) => (
            <div className={styles.fieldRow} key={field.label}>
              <dt>{field.label}</dt>
              <dd dir="auto" className={styles.genericValue}>
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {approval.reasons.length > 0 && (
        <section className={styles.why} aria-labelledby={`why-${approval.id}`}>
          <h3 id={`why-${approval.id}`} className={styles.whyTitle}>
            {t('approvals.why')}
          </h3>
          <ul className={styles.reasons}>
            {approval.reasons.map((code) => (
              <li key={code}>
                {tDynamic(`approvals.reasons.${code}`, 'approvals.reasons.unknown', { code })}
              </li>
            ))}
          </ul>
        </section>
      )}

      {decide.isError && <ErrorBanner error={decide.error} />}

      {isPending && (
        <div className={styles.noteArea}>
          {noteOpen ? (
            <TextArea
              label={t('approvals.note.label')}
              hint={t('approvals.note.hint')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
              maxRows={6}
              dir="auto"
              // eslint-disable-next-line jsx-a11y/no-autofocus -- revealed by an explicit click
              autoFocus
            />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setNoteOpen(true)}
              className={styles.addNote}
            >
              {t('approvals.note.add')}
            </Button>
          )}
        </div>
      )}

      {isPending && (
        <div className={styles.actions}>
          <Button
            variant="secondary"
            size="lg"
            icon={X}
            onClick={() => decide.mutate('reject')}
            disabled={deciding !== null && deciding !== 'reject'}
            loading={deciding === 'reject'}
            aria-label={
              isEmail ? t('approvals.declineLabel.email') : t('approvals.declineLabel.generic')
            }
          >
            {t('approvals.decline')}
          </Button>
          <Button
            variant="primary"
            size="lg"
            icon={Check}
            onClick={() => decide.mutate('approve')}
            disabled={deciding !== null && deciding !== 'approve'}
            loading={deciding === 'approve'}
            aria-label={
              isEmail ? t('approvals.approveLabel.email') : t('approvals.approveLabel.generic')
            }
          >
            {isEmail ? t('approvals.approve.email') : t('approvals.approve.generic')}
          </Button>
        </div>
      )}
    </div>
  );
}

function DecidedNote({ approval }: { approval: Approval }) {
  const { t } = useI18n();
  const status = approval.status;
  if (status === 'PENDING') return null;
  if (status === 'CANCELLED' || status === 'SUPERSEDED') {
    return <Banner tone="info" title={t(`approvals.decided.${status}`)} />;
  }
  const at = approval.decidedAt ?? approval.expiresAt;
  return (
    <Banner tone={status === 'APPROVED' ? 'success' : 'info'}>
      <RelativeTime value={at} format={(time) => t(`approvals.decided.${status}`, { time })} />
    </Banner>
  );
}
