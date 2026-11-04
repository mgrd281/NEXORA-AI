/**
 * Service boundary between the HTTP layer and the agent runtime.
 * The runtime (modules/agent) implements these; route handlers depend only
 * on the interfaces, which keeps both sides independently testable.
 *
 * Phase B additions (followUp, SkillService, AppDeps.storage) are FROZEN by
 * docs/architecture/phase-b.md §4; change them only through that document.
 */
import type {
  Approval,
  ApprovalDecisionRequest,
  AssistantStatus,
  CreateTaskRequest,
  FollowUpRequest,
  Platform,
  Skill,
  SkillId,
  TaskSummary,
} from '@jarvis/contracts';
import type { Config } from './config';
import type { Db, DbContext } from './db/pool';
import type { SecretBox } from './lib/crypto';
import type { ModelAdapter } from './modules/agent/models/adapter';
import type { ObjectStorage } from './modules/storage/types';

export interface TaskService {
  /**
   * Creates conversation + user message + QUEUED task and enqueues planning,
   * atomically. Phase B: also links `input.attachmentIds` (the caller's own
   * unattached, unexpired uploads; moved into the new conversation) — or
   * rejects with VALIDATION_FAILED, details.reason ATTACHMENT_NOT_FOUND |
   * ATTACHMENT_EXPIRED | ATTACHMENT_IN_OTHER_CONVERSATION | TOO_MANY_ATTACHMENTS.
   */
  create(
    ctx: DbContext,
    input: CreateTaskRequest,
    opts: { idempotencyKey?: string },
  ): Promise<TaskSummary>;
  /**
   * Phase B: a new QUEUED task in an existing conversation (user message,
   * attachment links, task.plan job, conversation.message event, conversation
   * updated_at bumped — one transaction). Attachments may be unattached
   * uploads or files already in this conversation. Rejects with NOT_FOUND
   * (not the caller's conversation) or INVALID_STATE, details.reason
   * CONVERSATION_BUSY { taskId } while a task of the conversation is active.
   * Idempotent per (user, Idempotency-Key) like create.
   */
  followUp(
    ctx: DbContext,
    conversationId: string,
    input: FollowUpRequest,
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

/** Phase B: the skills registry (modules/agent/skills) with per-user availability. */
export interface SkillService {
  /** Every registry skill, in registry order, with the caller's real availability. */
  list(ctx: DbContext): Promise<Skill[]>;
  /**
   * Switches a skill for the caller: writes preferences.skills.disabled (for
   * personal-memory: preferences.memory.enabled), audits it, returns the entry.
   * Rejects with INVALID_STATE, details.reason SKILL_PLANNED | SKILL_NOT_TOGGLEABLE.
   * Never changes risk, approvals or any other permission.
   */
  setEnabled(ctx: DbContext, id: SkillId, enabled: boolean): Promise<Skill>;
}

export interface AgentServices {
  tasks: TaskService;
  approvals: ApprovalService;
  status: AssistantStatusService;
  /** Phase B. */
  skills: SkillService;
}

export interface AppDeps {
  config: Config;
  db: Db;
  secrets: SecretBox;
  agent: AgentServices;
  /** Phase B: attachment storage, or null when STORAGE_DRIVER resolves to 'none'. */
  storage: ObjectStorage | null;
  /** Dedicated LISTEN connection factory for the SSE stream. */
  listen: (channel: string, onMessage: (payload: string) => void) => Promise<() => Promise<void>>;
  /**
   * Phase D: the model adapter for request-time model use in the API process — the call
   * dialog engine answering telephony webhooks in model mode (each user's route, budget and
   * external-model setting still apply). null/absent = offline (no API key); tests inject
   * the scripted adapter.
   */
  modelAdapter?: ModelAdapter | null;
}
