import Foundation

// Mirrors packages/contracts/src/enums.ts.
//
// Every enum the server sends decodes leniently: a value this build does not know
// (because the server is newer) becomes `.unknown` instead of failing the whole
// response. Each type declares `init(from:)` itself so the behaviour never depends
// on protocol-extension overload resolution.

enum LenientEnum {
    static func decode<T: RawRepresentable>(
        _ decoder: any Decoder,
        fallback: T
    ) throws -> T where T.RawValue == String {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        return T(rawValue: raw) ?? fallback
    }
}

/// Interface language (`Locale` in the contracts).
enum AppLocale: String, Codable, Sendable, CaseIterable {
    case en
    case de
    case ar
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }

    /// The language this app is currently displayed in. Follows the per-app language
    /// chosen in iOS Settings (falls back to English).
    static var current: AppLocale {
        let code = Bundle.main.preferredLocalizations.first ?? "en"
        let base = code.split(separator: "-").first.map(String.init) ?? code
        switch AppLocale(rawValue: base) {
        case .some(.unknown), .none: return .en
        case .some(let locale): return locale
        }
    }
}

enum ThemePreference: String, Codable, Sendable, CaseIterable {
    case system
    case light
    case dark
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

enum Platform: String, Codable, Sendable {
    case web
    case ios
    case android
    case macos
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

enum Role: String, Codable, Sendable {
    case owner
    case member
    case platformAdmin = "platform_admin"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// Risk classification enforced by the server's deterministic policy engine.
enum RiskLevel: String, Codable, Sendable, CaseIterable {
    case low = "LOW"
    case medium = "MEDIUM"
    case high = "HIGH"
    case critical = "CRITICAL"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

enum TaskStatus: String, Codable, Sendable, CaseIterable {
    case queued = "QUEUED"
    case planning = "PLANNING"
    case awaitingApproval = "AWAITING_APPROVAL"
    case running = "RUNNING"
    case verifying = "VERIFYING"
    case completed = "COMPLETED"
    case failed = "FAILED"
    case cancelled = "CANCELLED"
    case expired = "EXPIRED"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

enum StepStatus: String, Codable, Sendable, CaseIterable {
    case pending = "PENDING"
    case awaitingApproval = "AWAITING_APPROVAL"
    case running = "RUNNING"
    case succeeded = "SUCCEEDED"
    case failed = "FAILED"
    case skipped = "SKIPPED"
    case cancelled = "CANCELLED"
    case blocked = "BLOCKED"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

enum ApprovalStatus: String, Codable, Sendable, CaseIterable {
    case pending = "PENDING"
    case approved = "APPROVED"
    case rejected = "REJECTED"
    case expired = "EXPIRED"
    case cancelled = "CANCELLED"
    case superseded = "SUPERSEDED"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

enum TaskSource: String, Codable, Sendable {
    case text
    case voice
    case schedule
    case api
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// The subset of `TaskSource` a client may submit (`CreateTaskRequest.source`).
enum TaskRequestSource: String, Encodable, Sendable {
    case text
    case voice
}

enum ToolId: String, Codable, Sendable {
    case webFetch = "web.fetch"
    case textSummarize = "text.summarize"
    case emailSend = "email.send"
    case memorySave = "memory.save"
    case assistantAnswer = "assistant.answer"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

enum ConnectionProvider: String, Codable, Sendable {
    case web
    case smtp
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

enum ConnectionStatus: String, Codable, Sendable {
    case active
    case error
    case expired
    case revoked
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

enum MemoryKind: String, Codable, Sendable, CaseIterable {
    case preference
    case fact
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

enum ErrorCode: String, Codable, Sendable, CaseIterable {
    case unauthenticated = "UNAUTHENTICATED"
    case forbidden = "FORBIDDEN"
    case notFound = "NOT_FOUND"
    case validationFailed = "VALIDATION_FAILED"
    case conflict = "CONFLICT"
    case rateLimited = "RATE_LIMITED"
    case idempotencyMismatch = "IDEMPOTENCY_MISMATCH"
    case invalidState = "INVALID_STATE"
    case approvalExpired = "APPROVAL_EXPIRED"
    case approvalMismatch = "APPROVAL_MISMATCH"
    case connectionRequired = "CONNECTION_REQUIRED"
    case connectionFailed = "CONNECTION_FAILED"
    case modelNotConfigured = "MODEL_NOT_CONFIGURED"
    case modelError = "MODEL_ERROR"
    case plannerUnsupported = "PLANNER_UNSUPPORTED"
    case policyDenied = "POLICY_DENIED"
    case budgetExceeded = "BUDGET_EXCEEDED"
    case toolFailed = "TOOL_FAILED"
    case toolTimeout = "TOOL_TIMEOUT"
    case outcomeUnknown = "OUTCOME_UNKNOWN"
    case verificationFailed = "VERIFICATION_FAILED"
    case fetchBlocked = "FETCH_BLOCKED"
    case internalError = "INTERNAL"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// Union of `TaskEventType` and the stream-only types (`StreamEvent.type`).
enum EventType: String, Codable, Sendable, CaseIterable {
    case taskCreated = "task.created"
    case taskStatusChanged = "task.status_changed"
    case planReady = "plan.ready"
    case stepStarted = "step.started"
    case stepSucceeded = "step.succeeded"
    case stepFailed = "step.failed"
    case stepBlocked = "step.blocked"
    case approvalRequested = "approval.requested"
    case approvalDecided = "approval.decided"
    case verificationPassed = "verification.passed"
    case verificationFailed = "verification.failed"
    case taskAnswerDelta = "task.answer.delta"
    case taskCancelRequested = "task.cancel_requested"
    case taskRetried = "task.retried"
    case notificationCreated = "notification.created"
    case connectionChanged = "connection.changed"
    case heartbeat
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// `Preferences.voice.recognitionLocale`; `auto` follows the interface language.
enum RecognitionLocale: String, Codable, Sendable, CaseIterable {
    case auto
    case enUS = "en-US"
    case deDE = "de-DE"
    case arSA = "ar-SA"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }

    /// The choices offered in Settings (excludes `.unknown`).
    static let selectable: [RecognitionLocale] = [.auto, .enUS, .deDE, .arSA]
}
