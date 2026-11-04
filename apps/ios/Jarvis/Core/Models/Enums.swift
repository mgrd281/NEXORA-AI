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
    // Phase B
    case documentAnalyze = "document.analyze"
    case textTranslate = "text.translate"
    case scheduleCreate = "schedule.create"
    case conversationRecall = "conversation.recall"
    case assistantClarify = "assistant.clarify"
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
    // Phase B (HTTP only; `error.details.reason` says which ApiErrorReason)
    case payloadTooLarge = "PAYLOAD_TOO_LARGE"
    case unsupportedMediaType = "UNSUPPORTED_MEDIA_TYPE"
    case serviceUnavailable = "SERVICE_UNAVAILABLE"
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
    // Phase B account events (AccountEventType)
    case conversationMessage = "conversation.message"
    case conversationChanged = "conversation.changed"
    case scheduleChanged = "schedule.changed"
    case webhookDeliveryFailed = "webhook.delivery_failed"
    case webhookEndpointChanged = "webhook.endpoint_changed"
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

// MARK: - Phase B (docs/architecture/phase-b.md)

/// What a COMPLETED task produced (`TaskOutcome`); nil until it completes.
enum TaskOutcome: String, Codable, Sendable, CaseIterable {
    /// Text for the user (an answer, summary or translation).
    case answer
    /// Something was done (an email sent, a memory saved, a schedule created).
    case action
    /// JARVIS needs information first; the user answers with a follow-up.
    case question
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// What a clarifying question asks for (`MissingInfo`).
enum MissingInfo: String, Codable, Sendable, CaseIterable {
    case emailContent = "email_content"
    case recipient
    case url
    case document
    case scheduleTime = "schedule_time"
    case targetLanguage = "target_language"
    case previousResult = "previous_result"
    case details
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// Kind of a conversation message (`MessageKind`).
enum MessageKind: String, Codable, Sendable, CaseIterable {
    case request
    case answer
    case question
    case result
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// File types JARVIS accepts (`AttachmentMediaType`), identified by the server from the content.
enum AttachmentMediaType: String, Codable, Sendable, CaseIterable {
    case pdf = "application/pdf"
    case docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    case plainText = "text/plain"
    case markdown = "text/markdown"
    case csv = "text/csv"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }

    /// The types a user can upload (excludes `.unknown`).
    static let uploadable: [AttachmentMediaType] = [.pdf, .docx, .plainText, .markdown, .csv]

    /// File-name extensions accepted per type (`ATTACHMENT_EXTENSIONS`), lower case with the dot.
    var extensions: [String] {
        switch self {
        case .pdf: [".pdf"]
        case .docx: [".docx"]
        case .plainText: [".txt"]
        case .markdown: [".md", ".markdown"]
        case .csv: [".csv"]
        case .unknown: []
        }
    }

    var isText: Bool {
        self == .plainText || self == .markdown || self == .csv
    }
}

/// The 12 skills of docs/skills (`SkillId`).
enum SkillId: String, Codable, Sendable, CaseIterable {
    case webResearch = "web-research"
    case emailManagement = "email-management"
    case calendarManagement = "calendar-management"
    case appointmentBooking = "appointment-booking"
    case phoneCalling = "phone-calling"
    case shoppingAssistant = "shopping-assistant"
    case documentAnalysis = "document-analysis"
    case taskScheduling = "task-scheduling"
    case personalMemory = "personal-memory"
    case deviceAutomation = "device-automation"
    case translation
    case workflowPlanning = "workflow-planning"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// Per user: built and usable, built but missing a connection, or not built yet.
enum SkillStatus: String, Codable, Sendable, CaseIterable {
    case implemented
    case needsConnection = "needs_connection"
    case planned
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// Why a skill cannot run for this user right now.
enum SkillUnavailableReason: String, Codable, Sendable, CaseIterable {
    case planned = "PLANNED"
    case disabledByUser = "DISABLED_BY_USER"
    case connectionRequired = "CONNECTION_REQUIRED"
    case modelRequired = "MODEL_REQUIRED"
    case memoryDisabled = "MEMORY_DISABLED"
    case storageNotConfigured = "STORAGE_NOT_CONFIGURED"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// How a skill uses AI models (`Skill.modelUse`).
enum SkillModelUse: String, Codable, Sendable, CaseIterable {
    /// Works without an AI model.
    case notUsed = "none"
    /// Uses a model when one is available.
    case whenAvailable = "optional"
    /// Needs a model.
    case needed = "required"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

enum ScheduleFrequency: String, Codable, Sendable, CaseIterable {
    case daily
    case weekly
    case monthly
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }

    /// The choices offered in the editor (excludes `.unknown`).
    static let selectable: [ScheduleFrequency] = [.daily, .weekly, .monthly]
}

/// RFC 5545 weekday codes.
enum Weekday: String, Codable, Sendable, CaseIterable {
    case monday = "MO"
    case tuesday = "TU"
    case wednesday = "WE"
    case thursday = "TH"
    case friday = "FR"
    case saturday = "SA"
    case sunday = "SU"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }

    /// Monday first, as RFC 5545 and the server order them (excludes `.unknown`).
    static let week: [Weekday] = [.monday, .tuesday, .wednesday, .thursday, .friday, .saturday, .sunday]

    /// `Calendar.weekdaySymbols` index (Sunday = 0), or nil for `.unknown`.
    var symbolIndex: Int? {
        switch self {
        case .sunday: 0
        case .monday: 1
        case .tuesday: 2
        case .wednesday: 3
        case .thursday: 4
        case .friday: 5
        case .saturday: 6
        case .unknown: nil
        }
    }
}

enum ScheduleStatus: String, Codable, Sendable, CaseIterable {
    case active
    case paused
    case completed
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

enum SchedulePauseReason: String, Codable, Sendable, CaseIterable {
    case user
    case failures
    case budget
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

enum ScheduleRunStatus: String, Codable, Sendable, CaseIterable {
    case created
    case skipped
    case failed
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

enum ScheduleRunReason: String, Codable, Sendable, CaseIterable {
    case budgetExhausted = "BUDGET_EXHAUSTED"
    case schedulePaused = "SCHEDULE_PAUSED"
    case createFailed = "CREATE_FAILED"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}
