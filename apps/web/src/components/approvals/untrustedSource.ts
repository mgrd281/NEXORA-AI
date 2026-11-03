import type { TaskDetail } from '@jarvis/contracts';

export interface UntrustedSourceFacts {
  /** Host of the fetched page that was flagged, e.g. "example.com". */
  host: string | null;
  /**
   * Whether the flagged text stayed out of the summary that feeds the action: true = the text
   * JARVIS summarized was not flagged (e.g. the instructions sat in hidden page elements), false =
   * it was flagged, so parts may appear in the summary, null = unknown (no summary step yet).
   */
  leftOut: boolean | null;
}

function hostOf(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

/**
 * What the task's own steps say about suspected instructions aimed at AI: which page they came
 * from (the web.fetch step whose output is flagged) and whether the summary JARVIS wrote from
 * it still carries them. Only real step output is used; anything missing stays null.
 */
export function untrustedSourceFacts(task: TaskDetail | undefined): UntrustedSourceFacts {
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
