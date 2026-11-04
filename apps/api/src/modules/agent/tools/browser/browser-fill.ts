/**
 * browser.fill — submit one of a supported site's declared forms (e.g. Fixture
 * Dental's contact form) with exactly the given fields
 * (docs/architecture/phase-c.md §3.5). MEDIUM (an external, non-reversible
 * submission: always asks, approval kind form_submission with every field);
 * HIGH and BINDING_COMMITMENT when the recipe declares the form a binding
 * commitment. Once per step: an interrupted submission is OUTCOME_UNKNOWN and
 * is never sent again blindly (the site receives the step's idempotency key).
 *
 * Fields are the user's words (or the account's name and email): references
 * are refused at planning, so page or mail content can never fill a form.
 */
import { msg, render } from '../../i18n';
import { z } from 'zod';
import { runBrowserSession } from '../../../browser/client';
import { getRecipe } from '../../../browser/sites';
import { hasTemplate } from '../../templates';
import { check, type ToolDefinition } from '../types';
import { orderedFields } from './booking-book';
import { artifactEvidence, enabledRecipe, outcomeError, plannedRecipe, SiteId } from './common';

export const BrowserFillInput = z.object({
  siteId: SiteId,
  form: z
    .string()
    .regex(/^[a-z][a-z_-]{0,31}$/)
    .describe('The recipe’s form id, e.g. "contact".'),
  fields: z
    .record(z.string().min(1).max(100), z.string().max(2000))
    .describe(
      'Exactly what each field receives, keyed by the form’s labels; literal text from the user (or the account’s name/email).',
    ),
});
export type BrowserFillInput = z.infer<typeof BrowserFillInput>;

const formOf = (input: BrowserFillInput) => getRecipe(input.siteId)?.forms?.[input.form];

export const browserFillTool: ToolDefinition<BrowserFillInput> = {
  id: 'browser.fill',
  version: '1.0.0',
  description:
    'Submit a declared form of a SUPPORTED site (e.g. fixture-booking "contact": Name, Email, Message) with exactly the given fields. Needs the user’s approval of every field. Field values must be the user’s own words; never references.',
  inputSchema: BrowserFillInput,
  validatePlanned(input) {
    const { recipe, issues } = plannedRecipe(input.siteId, 'fill');
    const out = issues.map((i) => `browser.fill: ${i}`);
    const form = recipe?.forms?.[input.form];
    if (recipe && !form) out.push(`browser.fill: ${recipe.name} has no form "${input.form}"`);
    for (const [k, v] of Object.entries(input.fields ?? {}))
      if (hasTemplate(k) || hasTemplate(v))
        out.push(
          'browser.fill fields must be written literally (the user’s words), never references',
        );
    if (form) {
      const labels = new Set(form.fields.map((f) => f.label.toLowerCase()));
      for (const k of Object.keys(input.fields ?? {}))
        if (!labels.has(k.trim().toLowerCase()))
          out.push(`browser.fill: the form has no field "${k}"`);
      for (const f of form.fields)
        if (
          f.required &&
          !Object.keys(input.fields ?? {}).some(
            (k) => k.trim().toLowerCase() === f.label.toLowerCase(),
          )
        )
          out.push(`browser.fill: the form needs "${f.label}" (ask the user)`);
    }
    return out;
  },
  outputFields: ['submitted', 'reference', 'sessionId'],
  requiredConnection: 'web',
  permissions: ['web:read', 'web:submit'],
  sideEffect: 'external',
  idempotency: 'once_per_step',
  timeoutMs: 150_000,
  retry: { maxAttempts: 1, retryableCodes: [] },
  modelUse: 'none',
  outbound: true,
  runsInBrowser: true,
  riskLevel: (input) => (formOf(input)?.commitment ? 'HIGH' : 'MEDIUM'),
  binding: (input) => formOf(input)?.commitment === true,
  estimateCostMicro: () => 0,
  preview: (input) => ({
    siteId: input.siteId,
    form: input.form,
    fields: Object.keys(input.fields),
  }),
  approvalDetails(input, ctx) {
    const recipe = getRecipe(input.siteId);
    const form = formOf(input);
    const site = recipe?.name ?? input.siteId;
    const summaryMessage = msg('approval.formSubmission', { site });
    return {
      details: {
        kind: 'form_submission',
        siteId: input.siteId,
        siteName: site,
        siteHost: ctx.siteHost?.(input.siteId) ?? recipe?.hostLabel ?? input.siteId,
        form: input.form,
        fields: orderedFields(input.fields, form?.fields ?? []).map(([label, value]) => ({
          label,
          value,
          personal:
            form?.fields.find((f) => f.label.toLowerCase() === label.toLowerCase())?.personal ??
            true,
        })),
        binding: form?.commitment === true,
        evidenceArtifactId: null,
      },
      summary: render(ctx.language, summaryMessage),
      summaryMessage,
    };
  },
  resultLine: (input) =>
    msg('result.formSubmitted', { site: getRecipe(input.siteId)?.name ?? input.siteId }),
  resultFact: (input, output) =>
    `Submitted the ${input.form} form on ${getRecipe(input.siteId)?.name ?? input.siteId}${output.reference ? ` (reference ${String(output.reference)})` : ''}`,
  audit: (input, output) => ({
    action: 'browser.form_submitted',
    metadata: { siteId: input.siteId, form: input.form, sessionId: output.sessionId ?? null },
  }),
  async execute(input, rt, signal) {
    const { recipe, origins } = enabledRecipe(rt.config, input.siteId);
    const o = await runBrowserSession(
      rt,
      {
        siteId: recipe.id,
        operation: 'fill',
        input: { form: input.form, fields: input.fields, idempotencyKey: `form:${rt.stepId}` },
      },
      signal,
    );
    if (o.status !== 'succeeded' || !o.result)
      throw outcomeError(o, {
        siteName: recipe.name,
        fallbackHost: new URL(origins[0]!).host,
        readOnly: false,
      });
    const r = o.result as { reference: string | null; screenshotArtifactId: string };
    return {
      output: {
        submitted: true,
        reference: r.reference,
        sessionId: o.sessionId,
        evidenceArtifactId: r.screenshotArtifactId,
      },
      outputPreview: {
        submitted: true,
        reference: r.reference,
        siteId: recipe.id,
        form: input.form,
      },
      evidence: artifactEvidence(o.artifacts),
      costMicro: 0,
    };
  },
  verify(_input, output) {
    const artifact = typeof output.evidenceArtifactId === 'string' ? output.evidenceArtifactId : '';
    return {
      ok: output.submitted === true && artifact.length > 0,
      checks: [
        check('screenshotStored', 'Screenshot of the site’s answer stored', {
          artifactId: artifact,
        }),
        ...(typeof output.reference === 'string'
          ? [
              check(
                'confirmationReceived',
                `The site confirmed it (reference ${output.reference})`,
                { reference: output.reference },
              ),
            ]
          : []),
      ],
    };
  },
};
