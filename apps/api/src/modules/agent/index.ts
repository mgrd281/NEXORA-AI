import type { Config } from '../../config';
import type { Db } from '../../db/pool';
import type { SecretBox } from '../../lib/crypto';
import type { AgentServices } from '../../services';

export interface AgentDeps {
  config: Config;
  db: Db;
  secrets: SecretBox;
}

/** Placeholder until the agent runtime is implemented. */
export function createAgentServices(_deps: AgentDeps): AgentServices {
  const notImplemented = () => {
    throw new Error('agent runtime not implemented');
  };
  return {
    tasks: { create: notImplemented, cancel: notImplemented, retry: notImplemented },
    approvals: { decide: notImplemented },
    status: { get: notImplemented },
  };
}
