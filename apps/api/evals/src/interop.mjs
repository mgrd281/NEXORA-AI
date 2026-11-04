/**
 * Node ESM interop for the eval runner (loaded with `tsx --import`).
 *
 * rrule ships CommonJS as "main" without an "exports" map, so under plain
 * Node ESM (tsx) `import { RRule } from 'rrule'` fails: Node cannot detect
 * its named exports. Vitest and the esbuild bundle paper over this; tsx does
 * not. This hook serves 'rrule' as an ES module re-exporting the CommonJS
 * module's properties (named + default), so the runtime code imports the
 * same way in evals as it does in tests. Only 'rrule' is touched.
 *
 * Remove once src/modules/schedules/recurrence.ts imports rrule in a way
 * Node ESM supports (default import), see docs/evals.md "Known issues".
 */
import { register } from 'node:module';

const hooks = `
import { fileURLToPath } from 'node:url';
const PREFIX = 'jarvis-interop:';
export async function resolve(specifier, context, next) {
  if (specifier !== 'rrule') return next(specifier, context);
  const real = await next(specifier, context);
  return { url: PREFIX + real.url, shortCircuit: true };
}
export async function load(url, context, next) {
  if (!url.startsWith(PREFIX)) return next(url, context);
  const real = url.slice(PREFIX.length);
  const file = fileURLToPath(real);
  const source = [
    "import { createRequire } from 'node:module';",
    'const m = createRequire(' + JSON.stringify(real) + ')(' + JSON.stringify(file) + ');',
    'export default m;',
    'export const { RRule, RRuleSet, rrulestr, Frequency, Weekday, datetime } = m;',
  ].join('\\n');
  return { format: 'module', source, shortCircuit: true };
}
`;

register(`data:text/javascript,${encodeURIComponent(hooks)}`);
