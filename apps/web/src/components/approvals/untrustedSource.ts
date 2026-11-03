import type { Approval, TaskDetail } from '@jarvis/contracts';
import type { TranslateFn } from '@/i18n/translate';

export interface UntrustedSourceFacts {
  /** Host of the fetched page that was flagged, e.g. "example.com". */
  host: string | null;
  /**
   * Whether the flagged text stayed out of the summary that feeds the action: true = the text
   * JARVIS summarized was not flagged (e.g. the instructions sat in hidden page elements, or
   * the extractive summary left those sentences out), false = it was flagged, so parts may
   * appear in the summary, null = unknown (no summary step yet).
   */
  leftOut: boolean | null;
  /** How many sentences addressing AI assistants the summary left out, when the server says. */
  excludedSentences: number | null;
}

function hostOf(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

/** The approval acts on content flagged as a prompt injection (the policy said so). */
export function isUntrustedApproval(approval: Pick<Approval, 'reasons' | 'details'>): boolean {
  return approval.reasons.includes('UNTRUSTED_CONTENT') || approval.details.untrusted !== undefined;
}

/** What the task's own steps say (for approvals recorded before details.untrusted existed). */
function factsFromSteps(
  task: TaskDetail | undefined,
): Omit<UntrustedSourceFacts, 'excludedSentences'> {
  if (!task) return { host: null, leftOut: null };
  const flaggedIndex = task.steps.findIndex(
    (step) => step.toolId === 'web.fetch' && step.output?.suspectedInjection === true,
  );
  if (flaggedIndex < 0) return { host: null, leftOut: null };
  const fetch = task.steps[flaggedIndex];
  const host =
    hostOf(fetch?.output?.finalUrl) ??
    hostOf(fetch?.output?.url) ??
    hostOf(fetch?.inputPreview.url);
  const summary = task.steps
    .slice(flaggedIndex + 1)
    .find((step) => step.toolId === 'text.summarize' && step.status === 'SUCCEEDED');
  const flagged = summary?.output?.suspectedInjection;
  const leftOut = typeof flagged === 'boolean' ? !flagged : null;
  return { host, leftOut };
}

/**
 * What is known about suspected instructions aimed at AI: the approval's own facts
 * (details.untrusted: the page's host and how many sentences the summary left out) first, then
 * the task's steps (the web.fetch step whose output is flagged and the summary written from
 * it). Only real data is used; anything missing stays null.
 */
export function untrustedSourceFacts(
  task: TaskDetail | undefined,
  approval?: Pick<Approval, 'details'> | null,
): UntrustedSourceFacts {
  const own = approval?.details.untrusted;
  const steps = factsFromSteps(task);
  const excluded = own?.excludedSentences ?? null;
  return {
    host: own?.host ?? steps.host,
    leftOut: excluded !== null && excluded > 0 ? true : steps.leftOut,
    excludedSentences: excluded !== null && excluded > 0 ? excluded : null,
  };
}

/** The warning in the interface language: which page, and what happened to its text. */
export function untrustedSourceSentences(
  t: TranslateFn,
  facts: UntrustedSourceFacts,
): { title: string; outcome: string | null } {
  const title = facts.host
    ? t('approvals.untrusted.title', { host: facts.host })
    : t('approvals.untrusted.titleNoHost');
  const outcome =
    facts.excludedSentences !== null
      ? t('approvals.untrusted.leftOutCount', { count: facts.excludedSentences })
      : facts.leftOut === true
        ? t('approvals.untrusted.leftOut')
        : facts.leftOut === false
          ? t('approvals.untrusted.mayInclude')
          : null;
  return { title, outcome };
}
