import type { StepRow } from '../../db/types';
import { asMessage } from './i18n';

/**
 * How step events (step.started / succeeded / failed / blocked) name their
 * step: the stored title, plus its message form when the server wrote it, so
 * the timeline can be shown in the viewer's locale.
 */
export function stepRef(step: StepRow) {
  const titleMessage = asMessage(step.title_message);
  return {
    stepId: step.id,
    toolId: step.tool_id,
    title: step.title,
    ...(titleMessage ? { titleMessage } : {}),
  };
}
