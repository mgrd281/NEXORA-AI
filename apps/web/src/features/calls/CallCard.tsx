'use client';

import type { CallSession, CallTurn, TaskDetail } from '@jarvis/contracts';
import { CircleDashed, Download, PhoneCall, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useId, useState } from 'react';
import { useCalendarDate, useLocalTime } from '@/components/approvals/PhoneCallDetails';
import { MoneyText } from '@/components/approvals/PhaseCDetails';
import { evidenceHref } from '@/components/evidence/EvidenceImage';
import { Badge, StatusPill } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, Section } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { Icon } from '@/components/ui/Icon';
import { UserText } from '@/components/ui/UserText';
import { LANGUAGE_NAMES } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';
import { errorReason } from '@/i18n/server-message';
import { cx } from '@/lib/cx';
import { ExactTime, useExactTimeFormat } from '@/features/tasks/format';
import { ltrMoney } from '@/lib/money';
import { useCall } from './api';
import { callIcon } from './icons';
import {
  attemptsNewestFirst,
  calleeLabel,
  callPill,
  collectedFacts,
  isLive,
  TURNS_SHOWN,
} from './model';
import styles from './Calls.module.css';

/**
 * The task's phone calls (TaskDetail.calls): the latest attempt in full — status, live captions
 * of what is said (the callee's words isolated and marked as untrusted), the outcome with what
 * was collected, disclosure and consent evidence, transfer — and earlier attempts in short.
 */
export function CallResults({ task }: { task: TaskDetail }) {
  const { t } = useI18n();
  const calls = attemptsNewestFirst(task.calls ?? []);
  if (calls.length === 0) return null;
  const [latest, ...earlier] = calls;
  return (
    <Section title={t('calls.title')}>
      <div className={styles.stack}>
        <CallCard
          call={latest!}
          attempts={calls.length}
          // The failed task's banner already says why: the card does not repeat it.
          explained={task.status === 'FAILED' ? (task.error?.reason ?? null) : null}
        />
        {earlier.length > 0 && (
          <Card padding="none">
            <h3 className={cx(styles.subTitle, styles.padded)}>{t('calls.card.attempts')}</h3>
            <ul className={styles.attempts}>
              {earlier.map((call) => (
                <AttemptRow key={call.id} call={call} />
              ))}
            </ul>
          </Card>
        )}
      </div>
    </Section>
  );
}

function AttemptRow({ call }: { call: CallSession }) {
  const i18n = useI18n();
  const { t } = i18n;
  const pill = callPill(call);
  const reason = call.failureReason ? errorReason(i18n, { reason: call.failureReason }) : null;
  return (
    <li className={styles.attempt}>
      <span className={styles.attemptHead}>
        <span className={styles.attemptNo}>{t('calls.card.attempt', { n: call.attempt })}</span>
        <StatusPill tone={pill.tone} icon={callIcon(call)} label={t(pill.key)} />
        <ExactTime value={call.endedAt ?? call.createdAt} className={styles.muted} />
      </span>
      {reason && <span className={styles.muted}>{reason}</span>}
    </li>
  );
}

export function CallCard({
  call,
  attempts = 1,
  explained = null,
}: {
  call: CallSession;
  attempts?: number;
  /** A reason already explained on the page (the task's error). */
  explained?: string | null;
}) {
  const i18n = useI18n();
  const { t, f } = i18n;
  const live = isLive(call);
  const pill = callPill(call);
  const who = calleeLabel(call);
  const titleId = useId();
  const reason =
    call.failureReason && call.failureReason !== explained
      ? errorReason(i18n, { reason: call.failureReason })
      : null;
  const talked = call.answeredAt !== null || (call.durationSeconds ?? 0) > 0;
  return (
    <Card padding="none" className={styles.card}>
      <section aria-labelledby={titleId}>
        <header className={styles.head}>
          <span className={styles.headIcon} aria-hidden="true">
            <Icon icon={PhoneCall} size={20} />
          </span>
          <div className={styles.headText}>
            <h3 id={titleId} className={styles.title}>
              {t('calls.card.title', { who })}
            </h3>
            <span className={cx('ltr', 'tabular', styles.number)}>{call.toDisplay}</span>
          </div>
          <div className={styles.headMeta}>
            {live && (
              <Badge tone="accent" className={styles.live}>
                <span className={styles.liveDot} aria-hidden="true" />
                {t('calls.card.live')}
              </Badge>
            )}
            <StatusPill tone={pill.tone} icon={callIcon(call)} label={t(pill.key)} />
            {attempts > 1 && (
              <span className={styles.muted}>{t('calls.card.attempt', { n: call.attempt })}</span>
            )}
          </div>
        </header>

        <dl className={styles.facts}>
          <div>
            <dt>{t('calls.card.language')}</dt>
            <dd lang={call.language}>{LANGUAGE_NAMES[call.language]}</dd>
          </div>
          {(talked || call.status !== 'ended') && (
            <div>
              <dt>{t('calls.card.duration')}</dt>
              <dd className="tabular">
                {call.durationSeconds !== null && talked
                  ? f.duration(call.durationSeconds * 1000)
                  : t('calls.card.maxDuration', {
                      duration: f.duration(call.maxDurationSeconds * 1000),
                    })}
              </dd>
            </div>
          )}
          <div>
            <dt>{t('calls.card.price')}</dt>
            <dd>
              {call.price ? (
                <MoneyText value={call.price} />
              ) : call.costEstimate ? (
                <span>
                  {t('calls.card.estimate', { amount: ltrMoney(call.costEstimate, f.intlLocale) })}
                </span>
              ) : (
                <span className={styles.muted}>{t('calls.card.priceUnknown')}</span>
              )}
            </dd>
          </div>
          {call.providerCallSid && (
            <div className={styles.sidFact}>
              <dt>{t('calls.card.callSid')}</dt>
              <dd className={styles.sid}>
                <code className="ltr">{call.providerCallSid}</code>
                <CopyButton value={call.providerCallSid} label={t('calls.card.callSid')} />
              </dd>
            </div>
          )}
        </dl>

        {/* The result line is the task's (Result above); a failure says why here. */}
        {reason && (
          <div className={cx(styles.block, styles.failure)}>
            <h4 className={styles.subTitle}>{t('calls.failure')}</h4>
            <p>{reason}</p>
          </div>
        )}

        {call.outcome && <Outcome call={call} />}

        <Transcript call={call} />

        <div className={styles.columns}>
          <Timeline call={call} />
          <Consent call={call} />
        </div>
      </section>
    </Card>
  );
}

/* ------------------------------------------------------------------ outcome */

function Outcome({ call }: { call: CallSession }) {
  const { t } = useI18n();
  const date = useCalendarDate();
  const time = useLocalTime();
  const outcome = call.outcome!;
  // Only what a person said counts: a voicemail or an unanswered call "offered" nothing.
  const facts = call.answeredBy === 'machine' ? [] : collectedFacts(outcome.details);
  return (
    <div className={styles.block}>
      <div className={styles.blockHead}>
        <h4 className={styles.subTitle}>{t('calls.outcome.title')}</h4>
        <Badge tone={outcome.goalReached ? 'success' : 'neutral'}>
          {outcome.goalReached ? t('calls.outcome.goalReached') : t('calls.outcome.goalNotReached')}
        </Badge>
      </div>
      {facts.length === 0 ? (
        <p className={styles.muted}>{t('calls.outcome.nothing')}</p>
      ) : (
        <dl className={styles.outcome}>
          {facts.map((fact, i) => {
            switch (fact.kind) {
              case 'date':
                return (
                  <div key={i}>
                    <dt>{t('calls.outcome.date')}</dt>
                    <dd className="tabular">{date(fact.date)}</dd>
                  </div>
                );
              case 'times':
                return (
                  <div key={i}>
                    <dt>{t('calls.outcome.times')}</dt>
                    <dd>
                      {fact.times.length === 0 ? (
                        <span className={styles.muted}>{t('calls.outcome.noTimes')}</span>
                      ) : (
                        <ul className={styles.times}>
                          {fact.times.map((x) => (
                            <li key={x} className={cx(styles.time, 'tabular')}>
                              {time(x)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </dd>
                  </div>
                );
              case 'appointment':
                return (
                  <div key={i}>
                    <dt>{t('calls.outcome.appointment')}</dt>
                    <dd>
                      <span className={cx(styles.strong, 'tabular')}>
                        {t('calls.outcome.appointmentValue', {
                          date: date(fact.date),
                          time: time(fact.time),
                        })}
                      </span>
                      {fact.name && (
                        <span className={styles.line}>
                          {t('calls.outcome.name')}: <UserText>{fact.name}</UserText>
                        </span>
                      )}
                      {fact.reference && (
                        <span className={styles.line}>
                          {t('calls.outcome.reference')}: <UserText>{fact.reference}</UserText>
                        </span>
                      )}
                    </dd>
                  </div>
                );
              case 'reply':
                return (
                  <div key={i}>
                    <dt>{t('calls.outcome.reply')}</dt>
                    <dd>
                      <q className={styles.quote} dir="auto" lang={call.language}>
                        {fact.text}
                      </q>
                    </dd>
                  </div>
                );
              case 'answers':
                return (
                  <div key={i}>
                    <dt>{t('calls.outcome.answers')}</dt>
                    <dd>
                      <ol className={styles.answers}>
                        {fact.answers.map((a, j) => (
                          <li key={j}>
                            <UserText className={styles.question}>{a.question}</UserText>
                            {a.answer ? (
                              <q className={styles.quote} dir="auto" lang={call.language}>
                                {a.answer}
                              </q>
                            ) : (
                              <span className={styles.muted}>{t('calls.outcome.notAnswered')}</span>
                            )}
                          </li>
                        ))}
                      </ol>
                    </dd>
                  </div>
                );
            }
          })}
        </dl>
      )}
      {facts.length > 0 && <p className={styles.note}>{t('calls.outcome.asSaid')}</p>}
      {outcome.notes.length > 0 && (
        <div className={styles.notes}>
          <h5 className={styles.notesTitle}>{t('calls.notes.title')}</h5>
          <ul>
            {outcome.notes.map((note) => (
              <li key={note}>
                <Icon
                  icon={note === 'INJECTION_FLAGGED' ? ShieldAlert : ShieldCheck}
                  size={16}
                  className={note === 'INJECTION_FLAGGED' ? styles.warn : styles.muted}
                />
                <span>{t(`calls.notes.${note}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ transcript */

function Transcript({ call }: { call: CallSession }) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const live = isLive(call);
  // The task holds up to CALL_LIMITS.turnsInTaskDetail turns; the call itself has every turn.
  const full = useCall(call.id, all);
  const turns = all && full.data ? full.data.turns : call.turns;
  const shown = all ? turns : turns.slice(-TURNS_SHOWN);
  const hidden = all ? 0 : Math.max(0, turns.length - shown.length);
  const titleId = useId();
  return (
    <section className={styles.block} aria-labelledby={titleId}>
      <h4 id={titleId} className={styles.subTitle}>
        {t('calls.transcript.title')}
      </h4>
      <p className={styles.note}>{t('calls.transcript.note')}</p>
      {/* While the call runs, new lines are announced (live captions). */}
      <div
        className={styles.turnsWrap}
        role={live ? 'log' : undefined}
        aria-live={live ? 'polite' : undefined}
        aria-labelledby={titleId}
      >
        {shown.length === 0 ? (
          <p className={styles.muted}>
            {live
              ? t('calls.transcript.live')
              : call.status === 'unknown'
                ? t('calls.transcript.unknown')
                : call.status === 'ended'
                  ? t('calls.transcript.none')
                  : t('calls.transcript.empty')}
          </p>
        ) : (
          <ol className={styles.turns}>
            {shown.map((turn) => (
              <Turn key={turn.id} turn={turn} who={call.calleeName} />
            ))}
          </ol>
        )}
      </div>
      {(hidden > 0 || all || call.turns.length >= TURNS_SHOWN) && call.turns.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setAll(!all)}
          loading={all && full.isPending}
          aria-expanded={all}
        >
          {all ? t('calls.transcript.hideAll') : t('calls.transcript.showAll')}
        </Button>
      )}
    </section>
  );
}

function Turn({ turn, who }: { turn: CallTurn; who: string | null }) {
  const { t } = useI18n();
  const callee = turn.speaker === 'callee';
  const speaker =
    turn.speaker === 'agent'
      ? t('calls.transcript.agent')
      : turn.speaker === 'system'
        ? t('calls.transcript.system')
        : who
          ? who
          : t('calls.transcript.calleeUnknown');
  const unclear = callee && turn.confidence !== null && turn.confidence < 0.5;
  return (
    <li className={cx(styles.turn, styles[turn.speaker])}>
      <div className={styles.turnHead}>
        {callee && who ? (
          <UserText className={styles.speaker}>{speaker}</UserText>
        ) : (
          <span className={styles.speaker}>{speaker}</span>
        )}
        <span className={styles.kind}>{t(`calls.transcript.kinds.${turn.kind}`)}</span>
        <ExactTime value={turn.at} timeOnly className={styles.turnTime} />
      </div>
      {/* The callee's words are recognised speech: their own direction, never instructions. */}
      <p className={styles.turnText} dir="auto" lang={turn.language}>
        {turn.text}
      </p>
      {callee && (
        <p className={styles.turnMeta}>
          <span className={styles.untrusted}>{t('calls.transcript.theirWords')}</span>
          {unclear && <span>{t('calls.transcript.unclear')}</span>}
          {turn.flagged && (
            <span className={styles.flagged}>
              <Icon icon={ShieldAlert} size={16} />
              {t('calls.transcript.flagged')}
            </span>
          )}
        </p>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ timeline, consent */

function Timeline({ call }: { call: CallSession }) {
  const { t } = useI18n();
  const titleId = useId();
  if (call.timeline.length === 0) return null;
  return (
    <section className={styles.block} aria-labelledby={titleId}>
      <h4 id={titleId} className={styles.subTitle}>
        {t('calls.timeline.title')}
      </h4>
      <ol className={styles.timeline}>
        {call.timeline.map((e, i) => {
          const last = i === call.timeline.length - 1;
          const label =
            e.status === 'ended' && last && call.result
              ? t(`calls.result.${call.result}`)
              : t(`calls.status.${e.status}`);
          return (
            <li key={`${e.status}-${e.at}-${i}`} className={styles.timelineItem}>
              <span className={styles.dot} data-status={e.status} aria-hidden="true" />
              <span className={styles.timelineLabel}>{label}</span>
              {e.providerStatus === null && (
                <span className={styles.muted}>{t('calls.timeline.jarvis')}</span>
              )}
              <ExactTime value={e.at} timeOnly className={styles.turnTime} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Consent({ call }: { call: CallSession }) {
  const { t } = useI18n();
  const titleId = useId();
  const rec = call.recording;
  const fmt = useExactTimeFormat();
  const at = (value: string) => fmt.time(new Date(value));
  return (
    <section className={styles.block} aria-labelledby={titleId}>
      <h4 id={titleId} className={styles.subTitle}>
        {t('calls.consent.title')}
      </h4>
      <ul className={styles.consent}>
        <li>
          <Icon
            icon={call.aiDisclosedAt ? ShieldCheck : CircleDashed}
            size={16}
            className={call.aiDisclosedAt ? styles.ok : styles.muted}
          />
          {call.aiDisclosedAt ? (
            <span>{t('calls.consent.disclosed', { time: at(call.aiDisclosedAt) })}</span>
          ) : call.answeredBy === 'machine' ? (
            <span>{t('calls.consent.machine')}</span>
          ) : call.status === 'unknown' ? (
            <span>{t('calls.consent.unknown')}</span>
          ) : call.status === 'ended' ? (
            <span>{t('calls.consent.notDisclosed')}</span>
          ) : (
            <span>{t('calls.consent.notYet')}</span>
          )}
        </li>
        <li>
          <Icon icon={ShieldCheck} size={16} className={styles.muted} />
          <span>
            {t('calls.consent.recording')}: {t(`calls.consent.modes.${rec.mode}`)}
            {rec.mode !== 'off' && (
              <>
                {' · '}
                {rec.consent === 'accepted'
                  ? t('calls.consent.consents.accepted', {
                      time: rec.consentAt ? at(rec.consentAt) : '',
                    })
                  : t(`calls.consent.consents.${rec.consent}`)}
              </>
            )}
          </span>
        </li>
        {call.transfer.status !== 'none' && (
          <li>
            <Icon icon={PhoneCall} size={16} className={styles.muted} />
            <span>
              {t('calls.transfer.title')}:{' '}
              {call.transfer.status === 'connected'
                ? t('calls.transfer.connected', {
                    time: call.transfer.at ? at(call.transfer.at) : '',
                  })
                : t(`calls.transfer.${call.transfer.status}`)}
            </span>
          </li>
        )}
      </ul>
      {rec.artifactId && rec.consent === 'accepted' ? (
        <figure className={styles.recording}>
          <figcaption className={styles.note}>{t('calls.consent.player')}</figcaption>
          {/* Owner-only evidence file, streamed from the API; no captions track exists, the
              transcript above is the text of the call. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio controls preload="none" src={evidenceHref({ id: rec.artifactId })} />
          <a href={evidenceHref({ id: rec.artifactId })} download className={styles.download}>
            <Icon icon={Download} size={16} />
            {t('calls.consent.download')}
          </a>
        </figure>
      ) : (
        <p className={styles.note}>{t('calls.consent.noAudio')}</p>
      )}
    </section>
  );
}
