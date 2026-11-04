/**
 * What JARVIS says aloud about a task in a voice conversation (pure, unit-tested): the answer
 * (streamed and stored), otherwise the result line in the viewer's language, the clarifying
 * question, or the localized error — the same words the task page shows, never a client-made
 * claim about an outcome.
 */
import type { TaskDetail } from '@jarvis/contracts';
import { isTerminal } from '@jarvis/contracts';
import type { Messages } from '@/i18n/catalog';
import { errorReason, errorTitle, renderServerMessage, serverText } from '@/i18n/server-message';
import { stripIsolates, type TranslateFn } from '@/i18n/translate';
import { isApiError } from '@/lib/api/client';
import type { SpokenLine, SubmitFailure, TaskView } from './engine/controller';

export interface ReplyI18n {
  t: TranslateFn;
  messages: Messages;
  f?: { intlLocale: string };
}

export interface ReplyLangs {
  /** BCP-47 of the interface (client copy, server sentences rendered here). */
  ui: string;
  /** BCP-47 of the request (model-written text is in the request's language). */
  request: string;
}

/**
 * Spoken text never carries the bidi isolation marks of rendered sentences, nor list markers:
 * each line of a multi-line result (an extractive summary's heading and bullets) becomes its own
 * sentence, so it is read — and captioned — as sentences rather than "report - By … - The …".
 */
export function plain(text: string): string {
  const lines = stripIsolates(text)
    .split(/\n+/)
    .map((l) =>
      l
        .replace(/^\s*(?:[-–•*]|\d{1,2}[.)])\s+/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? '';
  return lines.map((l) => (/[.!?;:…؟،,]$/.test(l) ? l : `${l}.`)).join(' ');
}

/**
 * The line for a task that asks, waits or ended; null while it works (and for an answer, which
 * is spoken from TaskDetail.answer and the stream).
 */
export function replyLine(i18n: ReplyI18n, task: TaskDetail, langs: ReplyLangs): SpokenLine | null {
  const { t } = i18n;
  switch (task.status) {
    case 'COMPLETED': {
      if (task.answer) return null;
      if (task.question) {
        return {
          text: plain(serverText(i18n, task.question.message, task.question.text)),
          lang: task.question.message ? langs.ui : langs.request,
          kind: 'question',
        };
      }
      if (task.resultSummary || task.resultSummaryMessage) {
        const rendered = renderServerMessage(i18n, task.resultSummaryMessage);
        return rendered !== null
          ? { text: plain(rendered), lang: langs.ui, kind: 'result' }
          : { text: plain(task.resultSummary ?? ''), lang: langs.request, kind: 'result' };
      }
      return { text: t('voice.conversation.lines.done'), lang: langs.ui, kind: 'result' };
    }
    case 'FAILED': {
      if (!task.error)
        return { text: t('tasks.banners.failedTitle'), lang: langs.ui, kind: 'error' };
      const reason = errorReason(i18n, task.error);
      const title = errorTitle(i18n, task.error);
      return {
        text: plain(reason ? `${title} ${reason}` : title),
        lang: langs.ui,
        kind: 'error',
      };
    }
    case 'CANCELLED': {
      const declined =
        task.resultSummaryMessage?.key === 'result.declined'
          ? renderServerMessage(i18n, task.resultSummaryMessage)
          : null;
      return {
        text: plain(declined ?? t('tasks.banners.cancelled')),
        lang: langs.ui,
        kind: 'result',
      };
    }
    case 'EXPIRED':
      return { text: t('tasks.banners.expired'), lang: langs.ui, kind: 'error' };
    default:
      return null;
  }
}

/** The pending approval of a task waiting for one. */
export function pendingApprovalId(task: TaskDetail): string | null {
  if (task.status !== 'AWAITING_APPROVAL') return null;
  return (
    task.approvals.find((a) => a.status === 'PENDING')?.id ??
    task.pendingApprovalId ??
    task.pendingApproval?.id ??
    null
  );
}

/** The controller's view of a task (see engine/controller.ts TaskView). */
export function taskView(i18n: ReplyI18n, task: TaskDetail, langs: ReplyLangs): TaskView {
  return {
    id: task.id,
    status: task.status,
    conversationId: task.conversationId,
    // The stored answer counts once the task is over (until then deltas stream it).
    answer: isTerminal(task.status) && task.status === 'COMPLETED' ? task.answer : null,
    answerLang: langs.request,
    line: replyLine(i18n, task, langs),
    approvalId: pendingApprovalId(task),
  };
}

/** 409 CONVERSATION_BUSY → "still busy"; no response / 5xx / 429 → retried; else shown. */
export function classifySubmitError(error: unknown): SubmitFailure {
  if (!isApiError(error)) return 'fatal';
  if (error.code === 'INVALID_STATE' && error.details?.reason === 'CONVERSATION_BUSY')
    return 'busy';
  if (
    error.code === 'NETWORK' ||
    error.code === 'RATE_LIMITED' ||
    error.code === 'SERVICE_UNAVAILABLE' ||
    error.code === 'INTERNAL' ||
    error.status >= 500
  )
    return 'network';
  return 'fatal';
}
