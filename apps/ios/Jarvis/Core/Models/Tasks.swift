import Foundation

// Mirrors the "Tasks" section of packages/contracts/src/schemas.ts.

struct TaskError: Decodable, Sendable, Equatable {
    let code: ErrorCode
    /// English developer fallback; the app shows copy for `code` / `reason` / `params`.
    let message: String
    /// Whether a retry is safe without risking a duplicate side effect.
    let retryable: Bool
    /// Which failure of the code (`TaskErrorReason`); a string so newer reasons decode.
    var reason: String? = nil
    var params: [String: JSONValue]? = nil
}

struct Evidence: Decodable, Sendable, Equatable {
    enum Kind: String, Codable, Sendable {
        case httpResponse = "http_response"
        case smtpReceipt = "smtp_receipt"
        case record
        case contentHash = "content_hash"
        case modelOutput = "model_output"
        case note
        case unknown

        init(from decoder: any Decoder) throws {
            self = try LenientEnum.decode(decoder, fallback: .unknown)
        }
    }

    let kind: Kind
    let label: String
    let value: String
    let at: Date
}

struct PolicyDecision: Decodable, Sendable, Equatable {
    enum Decision: String, Codable, Sendable {
        case allow
        case requireApproval = "require_approval"
        case deny
        case unknown

        init(from decoder: any Decoder) throws {
            self = try LenientEnum.decode(decoder, fallback: .unknown)
        }
    }

    let decision: Decision
    /// Machine-readable reason codes, e.g. RISK_MEDIUM, RECIPIENT_EXTERNAL.
    let reasons: [String]
}

struct TaskStep: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let position: Int
    let title: String
    /// Set when the server wrote the title (offline planner): shown in the app's language.
    var titleMessage: ServerMessage? = nil
    let toolId: ToolId
    let riskLevel: RiskLevel
    let status: StepStatus
    let requiresApproval: Bool
    let policy: PolicyDecision
    /// Redacted, display-safe view of the resolved input.
    let inputPreview: [String: JSONValue]
    /// Redacted, display-safe output.
    let output: [String: JSONValue]?
    let evidence: [Evidence]
    let attempts: Int
    let startedAt: Date?
    let completedAt: Date?
    let error: TaskError?

    var displayTitle: String { titleMessage.rendered(or: title) }
}

struct PlannerInfo: Decodable, Sendable, Equatable {
    enum Mode: String, Codable, Sendable {
        /// An external LLM planned the task.
        case model
        /// The deterministic rules engine planned the task.
        case offline
        case unknown

        init(from decoder: any Decoder) throws {
            self = try LenientEnum.decode(decoder, fallback: .unknown)
        }
    }

    let mode: Mode
    let provider: String?
    let model: String?
}

struct TaskProgress: Decodable, Sendable, Equatable {
    let completed: Int
    let total: Int

    /// 0...1, or nil while the plan has no steps yet.
    var fraction: Double? {
        guard total > 0 else { return nil }
        return min(1, max(0, Double(completed) / Double(total)))
    }
}

/// `TaskSummary.pendingApproval`.
struct PendingApprovalRef: Decodable, Sendable, Equatable {
    let id: String
    /// The action consumes content flagged as a suspected prompt injection.
    let untrustedSource: Bool
}

/// A clarifying question (`AssistantQuestion`): JARVIS asks instead of inventing missing
/// information; the user answers with a follow-up in the same conversation.
struct AssistantQuestion: Decodable, Sendable, Equatable {
    /// In the request's language.
    let text: String
    /// Set when the server composed the question: shown in the app's language.
    let message: ServerMessage?
    let missing: [MissingInfo]

    var displayText: String { message.rendered(or: text) }
}

struct TaskSummary: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let title: String
    let request: String
    let status: TaskStatus
    let riskLevel: RiskLevel
    let source: TaskSource
    let progress: TaskProgress
    let pendingApprovalId: String?
    let resultSummary: String?
    let error: TaskError?
    let createdAt: Date
    let updatedAt: Date
    let completedAt: Date?
    // Server-written sentences (absent from older servers).
    var titleMessage: ServerMessage? = nil
    var resultSummaryMessage: ServerMessage? = nil
    var pendingApproval: PendingApprovalRef? = nil
    // Phase B. Always sent by the current API; optional for older servers and fixtures.
    var conversationId: String? = nil
    /// What the completed task produced; nil until COMPLETED.
    var outcome: TaskOutcome? = nil
    /// Set when `outcome` is `.question`.
    var question: AssistantQuestion? = nil
    /// The schedule that created this task (source `schedule`).
    var scheduleId: String? = nil
    var attachmentCount: Int? = nil

    var displayTitle: String { titleMessage.rendered(or: title) }

    var displayResult: String? {
        if let message = resultSummaryMessage, let text = message.rendered { return text }
        return resultSummary
    }

    /// Completed with a clarifying question: the user's answer is the next step.
    var needsAnswer: Bool { status == .completed && outcome == .question }
}

struct TaskEvent: Decodable, Sendable, Equatable, Identifiable {
    /// Monotonic id; doubles as the SSE `id:` for resumable streams.
    let id: String
    let taskId: String
    let type: EventType
    let at: Date
    let data: [String: JSONValue]
}

struct TaskCost: Decodable, Sendable, Equatable {
    /// Integer micro-dollars (1 USD = 1,000,000).
    let estimatedMicroUsd: Int64
    let actualMicroUsd: Int64
}

/// `TaskSummary.extend({...})` in the contracts.
struct TaskDetail: Decodable, Sendable, Equatable, Identifiable {
    // TaskSummary fields
    let id: String
    let title: String
    let request: String
    let status: TaskStatus
    let riskLevel: RiskLevel
    let source: TaskSource
    let progress: TaskProgress
    let pendingApprovalId: String?
    let resultSummary: String?
    let error: TaskError?
    let createdAt: Date
    let updatedAt: Date
    let completedAt: Date?
    var titleMessage: ServerMessage? = nil
    var resultSummaryMessage: ServerMessage? = nil
    var pendingApprovalRef: PendingApprovalRef? = nil
    var outcome: TaskOutcome? = nil
    var question: AssistantQuestion? = nil
    var scheduleId: String? = nil
    var attachmentCount: Int? = nil
    // Detail fields
    let objective: String?
    var objectiveMessage: ServerMessage? = nil
    let conversationId: String
    let planner: PlannerInfo?
    let answer: String?
    let steps: [TaskStep]
    let approvals: [Approval]
    let events: [TaskEvent]
    let cost: TaskCost
    let evidence: [Evidence]
    let canCancel: Bool
    let canRetry: Bool
    let startedAt: Date?
    /// Files attached to the request (Phase B; absent from older servers).
    var attachments: [Attachment]? = nil

    private enum CodingKeys: String, CodingKey {
        case id, title, request, status, riskLevel, source, progress, pendingApprovalId
        case resultSummary, error, createdAt, updatedAt, completedAt
        case titleMessage, resultSummaryMessage
        case pendingApprovalRef = "pendingApproval"
        case outcome, question, scheduleId, attachmentCount
        case objective, objectiveMessage, conversationId, planner, answer, steps, approvals
        case events, cost, evidence, canCancel, canRetry, startedAt, attachments
    }

    var displayTitle: String { titleMessage.rendered(or: title) }

    var displayResult: String? {
        if let message = resultSummaryMessage, let text = message.rendered { return text }
        return resultSummary
    }

    var displayObjective: String? {
        if let message = objectiveMessage, let text = message.rendered { return text }
        return objective
    }

    var needsAnswer: Bool { status == .completed && outcome == .question }

    var pendingApproval: Approval? {
        if let id = pendingApprovalId, let match = approvals.first(where: { $0.id == id }) {
            return match
        }
        return approvals.first(where: { $0.status == .pending })
    }

    /// True when the last attempt may already have had its side effect (for example an
    /// email that may have been sent). Retrying then needs an explicit acknowledgement.
    var hasUnknownOutcome: Bool {
        error?.code == .outcomeUnknown || steps.contains { $0.error?.code == .outcomeUnknown }
    }
}

/// `POST /v1/tasks`.
struct CreateTaskRequest: Encodable, Sendable, Equatable {
    let request: String
    let source: TaskRequestSource
    /// Language of the request, if known (voice recognition supplies it).
    let language: AppLocale?
    let voiceSessionId: String?
    /// Uploaded files the request is about (Phase B). Omitted when nil; never sent empty.
    var attachmentIds: [String]? = nil
}

/// `POST /v1/conversations/:id/messages` has the same body as `POST /v1/tasks`.
typealias FollowUpRequest = CreateTaskRequest

/// `POST /v1/tasks/:id/retry`.
struct RetryTaskRequest: Encodable, Sendable, Equatable {
    /// Required when the previous attempt ended with OUTCOME_UNKNOWN.
    let acknowledgeUnknownOutcome: Bool
}

/// `TaskListQuery.status`.
enum TaskListFilter: String, Sendable, CaseIterable, Identifiable {
    case all
    case active
    case needsApproval = "needs_approval"
    case completed
    case failed

    var id: String { rawValue }
}
