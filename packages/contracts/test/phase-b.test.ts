import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_LIMITS,
  AttachmentMediaType,
  ErrorCode,
  NotificationKind,
  PolicyReason,
  SkillId,
  TaskErrorReason,
  ToolId,
  WEBHOOK_LIMITS,
  WebhookDeliveryEventType,
  WebhookEventType,
} from '../src/index';
import {
  AccountEventType,
  ApprovalDetails,
  AssistantStatus,
  Attachment,
  ConversationDetail,
  ConversationTurn,
  CreateScheduleRequest,
  CreateTaskRequest,
  CreateWebhookRequest,
  DEFAULT_PREFERENCES,
  FollowUpRequest,
  Me,
  Preferences,
  Recurrence,
  ServerMessageKey,
  Skill,
  StreamEvent,
  TaskDetail,
  TaskSummary,
  UpdateMeRequest,
  UpdateWebhookRequest,
  WebhookPayload,
} from '../src/schemas';
import { routes, type RouteDef } from '../src/routes';

const ID = '00000000-0000-4000-8000-000000000001';
const ID2 = '00000000-0000-4000-8000-000000000002';
const AT = '2026-11-03T09:00:00.000Z';

/** A Milestone 1 TaskSummary, exactly as older servers and fixtures send it. */
const LEGACY_SUMMARY = {
  id: ID,
  title: 'Summarize example.com',
  titleMessage: { key: 'plan.summarize', params: { host: 'example.com' } },
  request: 'summarize https://example.com',
  status: 'COMPLETED',
  riskLevel: 'LOW',
  source: 'text',
  progress: { completed: 2, total: 2 },
  pendingApprovalId: null,
  pendingApproval: null,
  resultSummary: 'A page about examples.',
  resultSummaryMessage: null,
  error: null,
  createdAt: AT,
  updatedAt: AT,
  completedAt: AT,
} as const;

const ATTACHMENT = {
  id: ID2,
  filename: 'Rechnung März.pdf',
  mediaType: 'application/pdf',
  sizeBytes: 48_213,
  sha256: 'a'.repeat(64),
  conversationId: ID,
  pageCount: 3,
  textChars: 5_120,
  downloadPath: `/v1/attachments/${ID2}/content`,
  expiresAt: null,
  createdAt: AT,
} as const;

/** JSON round trip: what a client decodes is what the server encoded. */
function roundTrip<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.parse(value);
  expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  return parsed;
}

describe('backwards compatibility', () => {
  it('older TaskSummary and TaskDetail payloads still decode', () => {
    expect(TaskSummary.safeParse(LEGACY_SUMMARY).success).toBe(true);
    const detail = {
      ...LEGACY_SUMMARY,
      objective: null,
      conversationId: ID,
      planner: null,
      answer: null,
      steps: [],
      approvals: [],
      events: [],
      cost: { estimatedMicroUsd: 0, actualMicroUsd: 0 },
      evidence: [],
      canCancel: false,
      canRetry: false,
      startedAt: null,
    };
    expect(TaskDetail.safeParse(detail).success).toBe(true);
  });

  it('stored preferences without the Phase B groups get their defaults', () => {
    const { retention: _r, skills: _s, ...milestone1 } = DEFAULT_PREFERENCES;
    const parsed = Preferences.parse(milestone1);
    expect(parsed.retention).toEqual({ memoryDays: null, taskHistoryDays: null });
    expect(parsed.skills).toEqual({ disabled: [] });
  });

  it('a Milestone 1 Me payload still decodes', () => {
    const { retention: _r, skills: _s, ...preferences } = DEFAULT_PREFERENCES;
    const me = {
      id: ID,
      email: 'a@example.com',
      displayName: 'A',
      locale: 'de',
      timeZone: 'Europe/Berlin',
      theme: 'system',
      roles: ['owner'],
      tenant: { id: ID2, name: 'T' },
      preferences,
      createdAt: AT,
    };
    expect(Me.parse(me).preferences.retention.memoryDays).toBeNull();
  });

  it('a create-task request without attachments still validates', () => {
    expect(CreateTaskRequest.parse({ request: 'hello' }).attachmentIds).toBeUndefined();
  });

  it('assistant status without the Phase B capabilities still decodes', () => {
    expect(
      AssistantStatus.safeParse({
        planner: { mode: 'offline', provider: null, reason: 'NO_API_KEY' },
        worker: { healthy: true, lastHeartbeatAt: AT },
        capabilities: { webFetch: true, email: false, memory: true, generalQuestions: false },
        version: '0.1.0',
      }).success,
    ).toBe(true);
  });
});

describe('Phase B schemas', () => {
  it('a task with a clarifying question round-trips', () => {
    const t = roundTrip(TaskSummary, {
      ...LEGACY_SUMMARY,
      resultSummary: 'What should the email say?',
      resultSummaryMessage: { key: 'question.emailContent', params: {} },
      conversationId: ID,
      outcome: 'question',
      question: {
        text: 'What should the email say?',
        message: { key: 'question.emailContent', params: {} },
        missing: ['email_content'],
      },
      scheduleId: null,
      attachmentCount: 0,
    });
    expect(t.outcome).toBe('question');
    expect(
      TaskSummary.safeParse({
        ...LEGACY_SUMMARY,
        question: { text: 'x', message: null, missing: [] },
      }).success,
    ).toBe(false);
  });

  it('attachment ids are unique and bounded', () => {
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(
      CreateTaskRequest.safeParse({
        request: 'x',
        attachmentIds: ids(ATTACHMENT_LIMITS.maxPerRequest),
      }).success,
    ).toBe(true);
    expect(
      CreateTaskRequest.safeParse({
        request: 'x',
        attachmentIds: ids(ATTACHMENT_LIMITS.maxPerRequest + 1),
      }).success,
    ).toBe(false);
    expect(CreateTaskRequest.safeParse({ request: 'x', attachmentIds: [ID, ID] }).success).toBe(
      false,
    );
    expect(FollowUpRequest.parse({ request: 'email it to me' }).source).toBe('text');
  });

  it('a conversation thread round-trips with all three turn types', () => {
    const user = {
      id: ID,
      role: 'user',
      kind: 'request',
      text: 'Fasse das Dokument zusammen',
      textMessage: null,
      language: 'de',
      taskId: ID,
      attachments: [ATTACHMENT],
      createdAt: AT,
    };
    const detail = roundTrip(ConversationDetail, {
      id: ID,
      title: 'Rechnung März.pdf zusammenfassen',
      titleMessage: { key: 'plan.summarizeDocument', params: { name: 'Rechnung März.pdf' } },
      taskCount: 1,
      lastTask: LEGACY_SUMMARY,
      hasActiveTask: false,
      scheduleId: null,
      createdAt: AT,
      updatedAt: AT,
      turns: [
        { type: 'user_message', message: user },
        { type: 'task', task: LEGACY_SUMMARY },
        {
          type: 'assistant_message',
          message: {
            ...user,
            id: ID2,
            role: 'assistant',
            kind: 'answer',
            text: 'Die Rechnung …',
            attachments: [],
          },
        },
      ],
      earlierCursor: null,
      canFollowUp: true,
      activeTaskId: null,
    });
    expect(detail.turns.map((t) => t.type)).toEqual(['user_message', 'task', 'assistant_message']);
    expect(ConversationTurn.safeParse({ type: 'note', message: user }).success).toBe(false);
  });

  it('attachments are limited to the five supported media types, each with extensions', () => {
    expect(Attachment.safeParse(ATTACHMENT).success).toBe(true);
    expect(Attachment.safeParse({ ...ATTACHMENT, mediaType: 'image/png' }).success).toBe(false);
    for (const t of AttachmentMediaType.options)
      expect(ATTACHMENT_EXTENSIONS[t].length).toBeGreaterThan(0);
  });

  it('recurrence rules: weekly needs weekdays, monthly needs days, until xor count', () => {
    const base = { time: '09:00', timeZone: 'Europe/Berlin' };
    const weekly = Recurrence.parse({ ...base, frequency: 'weekly', byWeekday: ['MO'] });
    expect(weekly.interval).toBe(1);
    expect(Recurrence.safeParse({ ...base, frequency: 'weekly' }).success).toBe(false);
    expect(Recurrence.safeParse({ ...base, frequency: 'daily', byWeekday: ['MO'] }).success).toBe(
      false,
    );
    expect(
      Recurrence.safeParse({ ...base, frequency: 'monthly', byMonthDay: [1, -1] }).success,
    ).toBe(true);
    expect(Recurrence.safeParse({ ...base, frequency: 'monthly', byMonthDay: [0] }).success).toBe(
      false,
    );
    expect(Recurrence.safeParse({ ...base, frequency: 'monthly' }).success).toBe(false);
    expect(
      Recurrence.safeParse({ ...base, frequency: 'daily', until: '2027-01-31', count: 3 }).success,
    ).toBe(false);
    expect(
      Recurrence.safeParse({ ...base, frequency: 'weekly', byWeekday: ['MO', 'MO'] }).success,
    ).toBe(false);
    for (const time of ['24:00', '9:00', '09:60', '0900'])
      expect(Recurrence.safeParse({ ...base, frequency: 'daily', time }).success, time).toBe(false);
    expect(
      CreateScheduleRequest.safeParse({
        title: 'Weekly digest',
        request: 'summarize https://example.com and email it to me',
        recurrence: { ...base, frequency: 'weekly', byWeekday: ['MO'] },
      }).success,
    ).toBe(true);
  });

  it('schedule and memory approvals round-trip', () => {
    roundTrip(ApprovalDetails, {
      kind: 'schedule',
      title: 'Weekly digest',
      request: 'summarize https://example.com and email it to me',
      recurrence: { frequency: 'weekly', byWeekday: ['MO'], time: '09:00', timeZone: 'UTC' },
      rrule: 'DTSTART;TZID=UTC:20261109T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO',
      nextOccurrences: [AT],
    });
    roundTrip(ApprovalDetails, {
      kind: 'memory',
      content: 'The museum opens at 10.',
      memoryKind: 'fact',
      sourceTaskId: ID,
    });
  });

  it('retention preferences accept only the offered periods', () => {
    expect(
      UpdateMeRequest.safeParse({ preferences: { retention: { memoryDays: 90 } } }).success,
    ).toBe(true);
    expect(
      UpdateMeRequest.safeParse({ preferences: { retention: { memoryDays: 45 } } }).success,
    ).toBe(false);
    expect(
      UpdateMeRequest.safeParse({ preferences: { retention: { taskHistoryDays: 30 } } }).success,
    ).toBe(false);
    // Skills are switched through PATCH /v1/skills/:id only.
    const patch = UpdateMeRequest.parse({ preferences: { skills: { disabled: ['translation'] } } });
    expect(patch.preferences).toEqual({});
  });

  it('a skill entry round-trips', () => {
    roundTrip(Skill, {
      id: 'translation',
      version: '1.0.0',
      status: 'implemented',
      enabled: true,
      canToggle: true,
      available: false,
      unavailableReason: 'MODEL_REQUIRED',
      tools: ['text.translate'],
      plannedTools: [],
      permissions: [],
      maxRisk: 'LOW',
      requiredConnections: [],
      modelUse: 'required',
      maxCostPerRunMicroUsd: 50_000,
      docsPath: 'docs/skills/translation.md',
    });
    expect(SkillId.options).toHaveLength(12);
  });

  it('webhook endpoints need http(s) URLs and distinct event types', () => {
    const ok = { url: 'https://hooks.example.com/jarvis', eventTypes: ['task.completed'] };
    expect(CreateWebhookRequest.safeParse(ok).success).toBe(true);
    expect(CreateWebhookRequest.safeParse({ ...ok, url: 'ftp://example.com' }).success).toBe(false);
    expect(CreateWebhookRequest.safeParse({ ...ok, eventTypes: [] }).success).toBe(false);
    expect(
      CreateWebhookRequest.safeParse({ ...ok, eventTypes: ['task.failed', 'task.failed'] }).success,
    ).toBe(false);
    // The test event is sent on request; it cannot be subscribed to.
    expect(CreateWebhookRequest.safeParse({ ...ok, eventTypes: ['webhook.test'] }).success).toBe(
      false,
    );
    expect(UpdateWebhookRequest.parse({ enabled: false })).toEqual({ enabled: false });
    expect(WebhookDeliveryEventType.options).toEqual([...WebhookEventType.options, 'webhook.test']);
  });

  it('webhook payloads carry ids and metadata, never content', () => {
    const task = roundTrip(WebhookPayload, {
      type: 'task.completed',
      timestamp: AT,
      data: {
        taskId: ID,
        conversationId: ID2,
        scheduleId: null,
        status: 'COMPLETED',
        outcome: 'action',
        riskLevel: 'MEDIUM',
        source: 'schedule',
        toolIds: ['web.fetch', 'text.summarize', 'email.send'],
        error: null,
        createdAt: AT,
        completedAt: AT,
      },
    });
    expect(Object.keys(task.data)).not.toContain('title');
    // Unknown keys (e.g. a title or request) are stripped, never passed through.
    const stripped = WebhookPayload.parse({
      type: 'webhook.test',
      timestamp: AT,
      data: { endpointId: ID, test: true, request: 'secret text' },
    });
    expect(JSON.stringify(stripped)).not.toContain('secret text');
    expect(WEBHOOK_LIMITS.retryDelaysSeconds).toHaveLength(WEBHOOK_LIMITS.maxAttempts - 1);
  });

  it('stream events accept the Phase B account events', () => {
    for (const type of AccountEventType.options) {
      expect(
        StreamEvent.safeParse({ id: '1', type, taskId: null, at: AT, data: {} }).success,
        type,
      ).toBe(true);
    }
  });

  it('enums keep their Milestone 1 values (additive only)', () => {
    for (const id of [
      'web.fetch',
      'text.summarize',
      'email.send',
      'memory.save',
      'assistant.answer',
    ])
      expect(ToolId.options).toContain(id);
    for (const k of ['approval_requested', 'task_completed', 'task_failed', 'connection_error'])
      expect(NotificationKind.options).toContain(k);
    for (const c of ['FETCH_BLOCKED', 'INTERNAL', 'OUTCOME_UNKNOWN'])
      expect(ErrorCode.options).toContain(c);
    for (const r of ['OFFLINE_UNSUPPORTED', 'PRIVATE_ADDRESS', 'POLICY_DENIED'])
      expect(TaskErrorReason.options).toContain(r);
    for (const k of ['plan.summarize', 'result.expired'])
      expect(ServerMessageKey.options).toContain(k);
    expect(PolicyReason.options).toContain('UNTRUSTED_CONTENT');
  });
});

describe('Phase B route table', () => {
  const all = Object.entries(routes) as [string, RouteDef][];

  it('every :param in a path is declared in its params schema, and nothing else', () => {
    for (const [name, r] of all) {
      const inPath = [...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]).sort();
      const declared = Object.keys(r.params?.shape ?? {}).sort();
      expect(declared, name).toEqual(inPath);
    }
  });

  it('uploads and downloads are declared consistently', () => {
    for (const [name, r] of all) {
      if (r.upload) {
        expect(r.body, name).toBeUndefined();
        expect(r.method, name).toBe('POST');
        expect(r.upload.maxBytes, name).toBe(ATTACHMENT_LIMITS.maxBytes);
      }
      if (r.download) {
        expect(r.method, name).toBe('GET');
        expect(r.response, name).toBeNull();
        expect(r.successStatus, name).toBe(200);
      }
      if (r.response === null && !r.download) expect(r.successStatus ?? 204, name).toBe(204);
    }
    expect(routes.uploadAttachment.upload.mediaTypes).toEqual(AttachmentMediaType.options);
  });

  it('only mutations take an Idempotency-Key, and never ones that reveal a secret', () => {
    for (const [name, r] of all) if (r.idempotent) expect(r.method, name).not.toBe('GET');
    // A replayed response would be stored, secret included, in idempotency_keys.
    expect('idempotent' in routes.createWebhook).toBe(false);
    expect('idempotent' in routes.rotateWebhookSecret).toBe(false);
  });

  it('a static segment never shadows a parameter of the same method', () => {
    // POST /v1/schedules/preview must not be read as POST /v1/schedules/:id.
    const byMethod = new Map<string, string[]>();
    for (const [, r] of all) byMethod.set(r.method, [...(byMethod.get(r.method) ?? []), r.path]);
    for (const [method, paths] of byMethod) {
      for (const p of paths) {
        const pattern = new RegExp(`^${p.replace(/:[A-Za-z]+/g, '[^/]+')}$`);
        const clashes = paths.filter((q) => q !== p && !q.includes(':') && pattern.test(q));
        expect(clashes, `${method} ${p}`).toEqual([]);
      }
    }
  });

  it('includes every Phase B endpoint', () => {
    expect(Object.keys(routes)).toEqual(
      expect.arrayContaining([
        'listConversations',
        'getConversation',
        'followUp',
        'deleteConversation',
        'uploadAttachment',
        'getAttachment',
        'downloadAttachment',
        'deleteAttachment',
        'listSkills',
        'updateSkill',
        'listSchedules',
        'createSchedule',
        'previewSchedule',
        'getSchedule',
        'updateSchedule',
        'deleteSchedule',
        'pauseSchedule',
        'resumeSchedule',
        'listWebhooks',
        'createWebhook',
        'updateWebhook',
        'deleteWebhook',
        'rotateWebhookSecret',
        'testWebhook',
        'listWebhookDeliveries',
        'listTimeZones',
      ]),
    );
    // Milestone 1 + Phase B; Phase C adds more (test/phase-c.test.ts counts them all).
    expect(Object.keys(routes).length).toBeGreaterThanOrEqual(35 + 26);
  });
});
