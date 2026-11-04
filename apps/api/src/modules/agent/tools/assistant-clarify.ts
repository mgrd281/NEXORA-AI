/**
 * assistant.clarify — ask the user for information a request needs instead of
 * inventing it (docs/architecture/phase-b.md §3.2). The task then COMPLETES
 * with outcome 'question' and JARVIS's question as its message; answering is
 * a follow-up in the same conversation.
 *
 * LOW risk, no side effect, no model, no cost. The question is either
 * written by the model planner (in the request's language) or composed by the
 * server from `missing` (a ServerMessage, so clients render it in the
 * viewer's locale). validatePlan makes it the only step of its plan.
 */
import {
  MissingInfo,
  type AssistantQuestion,
  type ServerMessage,
  type ServerMessageKey,
} from '@jarvis/contracts';
import { z } from 'zod';
import { truncate } from '../../../lib/redact';
import { msg, render } from '../i18n';
import { hasTemplate } from '../templates';
import { check, evidence, genericApprovalSummary, type ToolDefinition } from './types';

export const ClarifyInput = z.object({
  missing: z
    .array(MissingInfo)
    .min(1)
    .max(3)
    .describe(
      'What the request lacks, most important first: email_content, recipient (an email address), url, document (a file to attach), schedule_time, target_language, previous_result, details.',
    ),
  question: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'The question to ask, in the language of the request: short, specific, one question. Omit to use the standard question for the first missing item.',
    ),
});
export type ClarifyInput = z.infer<typeof ClarifyInput>;

export const QUESTION_KEY: Record<MissingInfo, ServerMessageKey> = {
  email_content: 'question.emailContent',
  recipient: 'question.recipient',
  url: 'question.url',
  document: 'question.document',
  schedule_time: 'question.scheduleTime',
  target_language: 'question.targetLanguage',
  previous_result: 'question.previousResult',
  details: 'question.details',
};

/** The question a clarify step asks: model-written text, or the server sentence for `missing[0]`. */
export function buildQuestion(
  input: ClarifyInput,
  language: Parameters<typeof render>[0],
): AssistantQuestion {
  const missing = [...new Set(input.missing)];
  if (input.question) return { text: input.question, message: null, missing };
  const message: ServerMessage = msg(QUESTION_KEY[missing[0]!]);
  return { text: render(language, message), message, missing };
}

export const assistantClarifyTool: ToolDefinition<ClarifyInput> = {
  id: 'assistant.clarify',
  version: '1.0.0',
  description:
    'Ask the user for information the request needs (content of an email, a recipient’s email address, a link, a file, a time, a target language, which earlier result) instead of guessing. Must be the only step of the plan. Output: question, missing.',
  inputSchema: ClarifyInput,
  validatePlanned(input) {
    return typeof input.question === 'string' && hasTemplate(input.question)
      ? ['assistant.clarify "question" must be literal text; references are not allowed.']
      : [];
  },
  outputFields: ['question', 'missing'],
  requiredConnection: null,
  permissions: [],
  sideEffect: 'none',
  idempotency: 'safe_to_retry',
  timeoutMs: 5_000,
  retry: { maxAttempts: 1, retryableCodes: [] },
  modelUse: 'none',
  riskLevel: () => 'LOW',
  estimateCostMicro: () => 0,
  preview: (input) => ({
    missing: input.missing,
    ...(input.question ? { question: truncate(input.question, 500) } : {}),
  }),
  approvalDetails: (input, ctx) => ({
    details: {
      kind: 'generic',
      toolId: 'assistant.clarify',
      fields: [{ label: 'Missing', value: input.missing.join(', ') }],
    },
    ...genericApprovalSummary(ctx, 'assistant.clarify'),
  }),
  async execute(input, rt) {
    const question = buildQuestion(input, rt.language);
    return {
      output: {
        question: question.text,
        questionMessage: question.message,
        missing: question.missing,
      },
      outputPreview: { question: question.text, missing: question.missing },
      evidence: [
        evidence(
          'note',
          'Question asked',
          `Asked for: ${question.missing.join(', ')}`,
          'QUESTION_ASKED',
          { missing: question.missing.join(',') },
        ),
      ],
      costMicro: 0,
    };
  },
  verify(_input, output) {
    const q = typeof output.question === 'string' ? output.question : '';
    return {
      ok: q.trim().length > 0 && Array.isArray(output.missing) && output.missing.length > 0,
      checks: [check('questionAsked', 'Question asked')],
    };
  },
};
