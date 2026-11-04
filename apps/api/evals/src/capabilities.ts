/**
 * Capability probes for `requires` (docs/evals.md "Pending scenarios").
 * A scenario whose capability is not in this build is reported as pending
 * with the missing capability named — never skipped silently, never failed
 * for something that is simply not there yet.
 *
 *   tool:<ToolId>              registered in the tool registry
 *   export:<module>#<name>     src/<module> exports <name> (e.g. modules/agent/jobs/schedule-run#schedulerTick)
 *   service:<method>           (pipeline) AgentServices.tasks.<method> is implemented
 *   storage                    (pipeline) attachment storage is configured
 */
import { getTool } from '../../src/modules/agent/tools/registry';
import type { AgentServices } from '../../src/services';
import type { Mode } from './scenario';

export interface ProbeEnv {
  mode: Mode;
  services?: AgentServices;
  storage?: boolean;
}

const moduleCache = new Map<string, Promise<Record<string, unknown> | null>>();

function loadModule(spec: string): Promise<Record<string, unknown> | null> {
  let p = moduleCache.get(spec);
  if (!p) {
    p = import(`../../src/${spec}`).then(
      (m: Record<string, unknown>) => m,
      () => null,
    );
    moduleCache.set(spec, p);
  }
  return p;
}

/** The capabilities of `requires` this build lacks (empty: all present). */
export async function missingCapabilities(
  requires: readonly string[],
  env: ProbeEnv,
): Promise<string[]> {
  const missing: string[] = [];
  for (const req of requires) {
    const [kind, arg = ''] = req.split(/:(.*)/s, 2);
    switch (kind) {
      case 'tool':
        if (!getTool(arg)) missing.push(req);
        break;
      case 'export': {
        const [spec, name] = arg.split('#');
        const mod = spec ? await loadModule(spec) : null;
        if (!mod || !name || mod[name] === undefined) missing.push(req);
        break;
      }
      case 'service': {
        if (env.mode !== 'pipeline') break;
        const fn = (env.services?.tasks as unknown as Record<string, unknown> | undefined)?.[arg];
        if (typeof fn !== 'function') missing.push(req);
        break;
      }
      case 'storage':
        if (env.mode === 'pipeline' && !env.storage) missing.push(req);
        break;
      default:
        missing.push(`${req} (unknown capability kind)`);
    }
  }
  return missing;
}
