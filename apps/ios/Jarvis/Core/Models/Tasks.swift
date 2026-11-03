import Foundation

// Mirrors the "Tasks" section of packages/contracts/src/schemas.ts.

struct TaskError: Decodable, Sendable, Equatable {
    let code: ErrorCode
    let message: String
    /// Whether a retry is safe without risking a duplicate side effect.
    let retryable: Bool
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
    // Detail fields
    let objective: String?
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
}

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
