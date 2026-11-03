/**
 * Service boundary between the HTTP layer and the agent runtime.
 * The runtime (modules/agent) implements these; route handlers depend only
 * on the interfaces, which keeps both sides independently testable.
 */
import type {
  Approval,
  ApprovalDecisionRequest,
  AssistantStatus,
  CreateTaskRequest,
  Platform,
  TaskSummary,
} from '@jarvis/contracts';
import type { Config } from './config';
import type { Db, DbContext } from './db/pool';
import type { SecretBox } from './lib/crypto';

export interface TaskService {
  /** Creates conversation + user message + QUEUED task and enqueues planning, atomically. */
  create(
    ctx: DbContext,
    input: CreateTaskRequest,
    opts: { idempotencyKey?: string },
  ): Promise<TaskSummary>;
  /** Cancels a non-terminal task; pending approvals are cancelled; running steps stop at the next checkpoint. */
  cancel(ctx: DbContext, taskId: string): Promise<TaskSummary>;
  /** Re-queues a FAILED/EXPIRED task, resuming from the first unfinished step. */
  retry(
    ctx: DbContext,
    taskId: string,
    opts: { acknowledgeUnknownOutcome: boolean },
  ): Promise<TaskSummary>;
}

export interface ApprovalService {
  /**
   * Approve or reject. Rejects with APPROVAL_MISMATCH if actionHash differs from
   * the stored hash (the user must have seen exactly what will run), and with
   * APPROVAL_EXPIRED / INVALID_STATE as appropriate.
   */
  decide(
    ctx: DbContext,
    approvalId: string,
    input: ApprovalDecisionRequest,
    channel: Platform,
  ): Promise<Approval>;
}

export interface AssistantStatusService {
  /** Real status: configured planner, user privacy setting, worker heartbeat, connected capabilities. */
  get(ctx: DbContext): Promise<AssistantStatus>;
}

export interface AgentServices {
  tasks: TaskService;
  approvals: ApprovalService;
  status: AssistantStatusService;
}

export interface AppDeps {
  config: Config;
  db: Db;
  secrets: SecretBox;
  agent: AgentServices;
  /** Dedicated LISTEN connection factory for the SSE stream. */
  listen: (channel: string, onMessage: (payload: string) => void) => Promise<() => Promise<void>>;
}
