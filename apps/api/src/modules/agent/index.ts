/**
 * Agent runtime entry point for the HTTP layer. Route handlers depend only
 * on the AgentServices interface (src/services.ts); the worker uses the job
 * handlers in ./jobs.
 */
import type { Config } from '../../config';
import type { Db } from '../../db/pool';
import type { SecretBox } from '../../lib/crypto';
import type { AgentServices } from '../../services';
import { createApprovalService } from '../approvals/service';
import type { ObjectStorage } from '../storage/types';
import { createTaskService } from '../tasks/service';
import { createSkillService } from './skills/service';
import { createStatusService } from './status';

export interface AgentDeps {
  config: Config;
  db: Db;
  secrets: SecretBox;
  /** Phase B: attachment storage (createStorage(config); null when STORAGE_DRIVER is 'none'). */
  storage: ObjectStorage | null;
}

export function createAgentServices(deps: AgentDeps): AgentServices {
  return {
    tasks: createTaskService(deps),
    approvals: createApprovalService(deps),
    status: createStatusService(deps),
    skills: createSkillService(deps),
  };
}
