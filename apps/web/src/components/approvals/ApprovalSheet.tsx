'use client';

import type { Approval, ApprovalDecisionRequest } from '@jarvis/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, TriangleAlert, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Banner, ErrorBanner } from '@/components/ui/Banner';
import { Badge, RiskBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { TextArea } from '@/components/ui/Field';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Sheet } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { UserText } from '@/components/ui/UserText';
import { useI18n } from '@/i18n/I18nProvider';
import { serverText } from '@/i18n/server-message';
import { api, isApiError, newIdempotencyKey } from '@/lib/api/client';
import { useApprovals } from '@/lib/api/hooks';
import { qk } from '@/lib/api/query-keys';
import { cx } from '@/lib/cx';
import { useNow } from '@/lib/hooks/useNow';
import styles from './ApprovalSheet.module.css';
import { ApprovalSentence } from './ApprovalSentence';
import {
  isUntrustedApproval,
  untrustedSourceFacts,
  untrustedSourceSentences,
} from './untrustedSource';

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
 * Shows exactly what will happen before JARVIS does it: the action in one sentence, the risk
 * and the policy reasons in plain language, when it expires, and for email the sender, every
 * recipient, the subject and the full body. Decline / Approve sit in the sheet's footer, always
 * in view. The decision is bound to the approval's actionHash, so a changed action is refused
 * (APPROVAL_MISMATCH) and shown again instead of being approved.
 *
 * Mounted only while open: closing (or a different approval) starts from a clean state, and the
 * dialog returns focus to the control that opened it.
 */
export function ApprovalSheet({
  approval,
  open,
  onClose,
  onDecided,
  hideTaskLink,
}: ApprovalSheetProps) {
  if (!open || !approval) return null;
  return (
    <ApprovalReview
      key={approval.id}
      approval={approval}
      onClose={onClose}
      onDecided={onDecided}
      hideTaskLink={hideTaskLink}
    />
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
  const i18n = useI18n();
  const { t, tDynamic } = i18n;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const pending = useApprovals();
  const now = useNow();
  const [decided, setDecided] = useState<Approval | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const noteRef = useRef<HTMLDivElement>(null);
  const keys = useRef(new Map<string, string>());

  // Revealing the note field: bring the whole field (label, box, hint) into view above the footer.
  useEffect(() => {
    if (noteOpen) noteRef.current?.scrollIntoView({ block: 'nearest' });
  }, [noteOpen]);

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
  const untrusted = isUntrustedApproval(approval);
  // The untrusted-source banner says this specifically; the list keeps the other reasons.
  const reasons = untrusted
    ? approval.reasons.filter((code) => code !== 'UNTRUSTED_CONTENT')
    : approval.reasons;

  const footer = isPending ? (
    <>
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
    </>
  ) : undefined;

  return (
    <Sheet
      open
      onClose={onClose}
      title={isEmail ? t('approvals.title.email') : t('approvals.title.generic')}
      placement="side"
      busy={deciding !== null}
      footer={footer}
    >
      <div className={styles.review}>
        <ApprovalSentence approval={approval} className={styles.summary} />

        <div className={styles.meta}>
          <RiskBadge level={approval.riskLevel} label={t(`common.risk.${approval.riskLevel}`)} />
          {untrusted && (
            <Badge tone="warning" icon={TriangleAlert} className={styles.untrustedChip}>
              {t('approvals.untrusted.chip')}
            </Badge>
          )}
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
              {/* Truncates at the end of the title's own direction, aligned with the row. */}
              <span className={styles.taskLinkText} dir="auto">
                {serverText(i18n, approval.taskTitleMessage, approval.taskTitle)}
              </span>
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
          (noLongerPending &&
            approval.status === 'PENDING' &&
            !expired &&
            notice !== 'expired')) && (
          <Banner tone="info" live title={t('approvals.errors.alreadyDecided')} />
        )}
        {approval.status !== 'PENDING' && <DecidedNote approval={approval} />}

        {reasons.length > 0 && (
          <section className={styles.why} aria-labelledby={`why-${approval.id}`}>
            <h3 id={`why-${approval.id}`} className={styles.whyTitle}>
              {t('approvals.why')}
            </h3>
            <ul className={styles.reasons}>
              {reasons.map((code) => (
                <li key={code}>
                  {tDynamic(`approvals.reasons.${code}`, 'approvals.reasons.unknown', { code })}
                </li>
              ))}
            </ul>
          </section>
        )}

        {untrusted && <UntrustedSourceBanner approval={approval} />}

        {approval.details.kind === 'email' ? (
          <div className={styles.email}>
            <dl className={styles.fields}>
              <div className={styles.fieldRow}>
                <dt>{t('approvals.fields.from')}</dt>
                <dd>
                  <Sender from={approval.details.from} />
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
                {approval.details.subject ? (
                  <UserText as="dd" className={styles.subject}>
                    {approval.details.subject}
                  </UserText>
                ) : (
                  <dd className={styles.subject}>{t('approvals.fields.noSubject')}</dd>
                )}
              </div>
            </dl>
            <div className={styles.bodyBlock}>
              <p className={styles.bodyLabel}>{t('approvals.fields.body')}</p>
              {/* The message is the whole surface here, so it follows its own direction. */}
              <pre className={styles.body} dir="auto">
                {approval.details.body}
              </pre>
            </div>
          </div>
        ) : (
          <dl className={styles.fields}>
            {approval.details.fields.map((field) => (
              <div className={styles.fieldRow} key={field.label}>
                <dt>{field.label}</dt>
                <UserText as="dd" className={styles.genericValue}>
                  {field.value}
                </UserText>
              </div>
            ))}
          </dl>
        )}

        {decide.isError && <ErrorBanner error={decide.error} />}

        {isPending && (
          <div className={styles.noteArea} ref={noteRef}>
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
      </div>
    </Sheet>
  );
}

/**
 * "Name <address>" as one unit in the name's own direction (so a Latin name reads
 * "Layla Haddad <…>" in Arabic too); it wraps between name and address, never inside it.
 */
function Sender({ from }: { from: string }) {
  const match = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(from.trim());
  if (!match || !match[1]) return <span className="ltr">{from}</span>;
  return (
    // The outer isolate takes its direction from the name (the address is isolated inside).
    <bdi>
      {match[1]} <span className={cx('ltr', styles.address)}>&lt;{match[2]}&gt;</span>
    </bdi>
  );
}

/**
 * Says what was found and what JARVIS did with it, from the task's own steps: which page tried
 * to instruct AI assistants and whether that text stayed out of the summary. Until the task
 * has loaded (or if it cannot) it says only what the approval itself knows.
 */
function UntrustedSourceBanner({ approval }: { approval: Approval }) {
  const { t } = useI18n();
  const taskId = approval.taskId;
  const task = useQuery({
    queryKey: qk.tasks.detail(taskId),
    queryFn: ({ signal }) => api.call('getTask', { params: { id: taskId }, signal }),
  });
  const { title, outcome } = untrustedSourceSentences(t, untrustedSourceFacts(task.data, approval));
  return (
    <Banner tone="warning" title={title}>
      <p>
        {outcome && <>{outcome} </>}
        {t('approvals.untrusted.check')}
      </p>
    </Banner>
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
