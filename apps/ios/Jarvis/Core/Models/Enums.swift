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
    // Phase C: email agent
    case emailSearch = "email.search"
    case emailReadThread = "email.read_thread"
    case emailDraftReply = "email.draft_reply"
    case emailTrackReplies = "email.track_replies"
    // Phase C: calendars
    case calendarList = "calendar.list"
    case calendarFreeBusy = "calendar.free_busy"
    case calendarCreateEvent = "calendar.create_event"
    case calendarUpdateEvent = "calendar.update_event"
    case calendarCancelEvent = "calendar.cancel_event"
    // Phase C: booking, browser agent, shopping (supported sites only)
    case bookingFindSlots = "booking.find_slots"
    case bookingBook = "booking.book"
    case browserRead = "browser.read"
    case browserFill = "browser.fill"
    case shopSearch = "shop.search"
    case shopCompare = "shop.compare"
    case shopPrepareCart = "shop.prepare_cart"
    case shopCheckout = "shop.checkout"
    // Phase D: an outbound phone call that says it is an AI assistant (approved by tap only)
    case phoneCall = "phone.call"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

enum ConnectionProvider: String, Codable, Sendable {
    case web
    case smtp
    // Phase C: OAuth 2.0 accounts
    case google
    case microsoft
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
    // Phase C account events (ids, enums and times only: screens refetch)
    case emailWatchChanged = "email_watch.changed"
    case browserSessionChanged = "browser_session.changed"
    case orderChanged = "order.changed"
    case bookingChanged = "booking.changed"
    // Phase D account events (ids, enums and times only: screens refetch)
    case callStatusChanged = "call.status_changed"
    case callTurn = "call.turn"
    case phoneVerificationChanged = "phone_verification.changed"
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
    // Phase C
    /// A date/time (window) for an event, a meeting or an appointment.
    case dateTime = "date_time"
    /// Details a booking form requires that JARVIS doesn't know (e.g. a phone number).
    case contactDetails = "contact_details"
    /// Which product, variant or quantity.
    case product
    /// Which supported site or shop.
    case site
    // Phase D
    /// Which number to call, written with its country code.
    case phoneNumber = "phone_number"
    /// What JARVIS should say or ask on the call.
    case callGoal = "call_goal"
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
    // Phase C
    /// None of the services the skill can use (Google, Microsoft) is configured on this server.
    case providerNotConfigured = "PROVIDER_NOT_CONFIGURED"
    /// The isolated browser agent isn't running on this server (or its evidence storage is missing).
    case browserUnavailable = "BROWSER_UNAVAILABLE"
    // Phase D
    /// This server has no telephony provider configured (phone calls are impossible here).
    case telephonyNotConfigured = "TELEPHONY_NOT_CONFIGURED"
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


// MARK: - Phase C (docs/architecture/phase-c.md)

/// Providers connected with OAuth 2.0 (authorization code + PKCE, run by the server).
enum OAuthProvider: String, Codable, Sendable, CaseIterable {
    case google
    case microsoft
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }

    /// The providers this build can connect (excludes `.unknown`).
    static let connectable: [OAuthProvider] = [.google, .microsoft]

    var connectionProvider: ConnectionProvider {
        switch self {
        case .google: .google
        case .microsoft: .microsoft
        case .unknown: .unknown
        }
    }
}

/// What JARVIS may do with an OAuth connection; each maps to least-privilege provider scopes.
enum ConnectionCapability: String, Codable, Sendable, CaseIterable {
    case mailRead = "mail.read"
    case mailCompose = "mail.compose"
    case mailSend = "mail.send"
    case calendarRead = "calendar.read"
    case calendarWrite = "calendar.write"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }

    /// In the order the server lists them (excludes `.unknown`).
    static let selectable: [ConnectionCapability] = [.mailRead, .mailCompose, .mailSend, .calendarRead, .calendarWrite]
}

/// Why a connection isn't active (`Connection.statusReason`).
enum ConnectionStatusReason: String, Codable, Sendable, CaseIterable {
    /// The provider refused the refresh token (revoked or ran out): reconnect.
    case grantInvalid = "GRANT_INVALID"
    /// The provider rejected a freshly refreshed token: reconnect.
    case tokenRejected = "TOKEN_REJECTED"
    /// A permission was withdrawn; the connection may stay active with less.
    case scopeMissing = "SCOPE_MISSING"
    /// Repeated provider failures.
    case providerError = "PROVIDER_ERROR"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// A thread JARVIS watches for replies (`email.track_replies`).
enum EmailWatchStatus: String, Codable, Sendable, CaseIterable {
    case watching
    case replied
    case stopped
    case expired
    case failed
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// One run of the isolated browser agent.
enum BrowserSessionStatus: String, Codable, Sendable, CaseIterable {
    case queued
    case running
    case succeeded
    case failed
    /// Stopped at something only the user may do (CAPTCHA, sign-in, bot protection).
    case handover
    /// The worker stopped mid-way; for a binding step the outcome is unknown.
    case interrupted
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// Why a browser session stopped before succeeding (also a `TaskErrorReason` of the same name).
enum BrowserStopReason: String, Codable, Sendable, CaseIterable {
    case captchaDetected = "CAPTCHA_DETECTED"
    case loginRequired = "LOGIN_REQUIRED"
    case botProtection = "BOT_PROTECTION"
    case siteUnsupported = "SITE_UNSUPPORTED"
    case navigationBlocked = "NAVIGATION_BLOCKED"
    case pageChanged = "PAGE_CHANGED"
    case siteError = "SITE_ERROR"
    case budgetExceeded = "BROWSER_BUDGET_EXCEEDED"
    case timeout = "BROWSER_TIMEOUT"
    case crashed = "BROWSER_CRASHED"
    case cancelled = "CANCELLED"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }

    /// The user continues on the site themselves (JARVIS never works around these).
    var isHandover: Bool {
        self == .captchaDetected || self == .loginRequired || self == .botProtection
    }
}

/// Files kept as evidence: the browser agent's (Phase C) and, only with the callee's consent,
/// a call recording (Phase D).
enum EvidenceArtifactKind: String, Codable, Sendable, CaseIterable {
    case screenshot
    case extract
    case ics
    case recording
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

enum EvidenceMediaType: String, Codable, Sendable, CaseIterable {
    case png = "image/png"
    case json = "application/json"
    case calendar = "text/calendar"
    /// Phase D: a call recording (only with the callee's consent).
    case mpeg = "audio/mpeg"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }

    /// File-name extension for a downloaded copy (Quick Look picks the viewer from it).
    var fileExtension: String {
        switch self {
        case .png: "png"
        case .json: "json"
        case .calendar: "ics"
        case .mpeg: "mp3"
        case .unknown: "bin"
        }
    }
}

/// An order placed by `shop.checkout`. The contract itself has a value `unknown` (the
/// outcome is unknown); a value from a newer server decodes to `.unrecognized`.
enum OrderStatus: String, Codable, Sendable, CaseIterable {
    case submitting
    case placed
    case failed
    /// Interrupted after submission started: check with the merchant before retrying.
    case outcomeUnknown = "unknown"
    case unrecognized

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unrecognized)
    }
}

/// An appointment booked by `booking.book` (same lifecycle as orders; `unknown` is a real value).
enum BookingStatus: String, Codable, Sendable, CaseIterable {
    case submitting
    case confirmed
    case failed
    /// Submitted, but the site showed no confirmation: check with the site before retrying.
    case outcomeUnknown = "unknown"
    case cancelled
    case unrecognized

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unrecognized)
    }
}

/// Facts about a merchant read from its own pages (never a JARVIS judgement).
enum ReliabilitySignalCode: String, Codable, Sendable, CaseIterable {
    case https
    case returnPolicy = "return_policy"
    case contactDetails = "contact_details"
    case legalNotice = "legal_notice"
    case customerRating = "customer_rating"
    case deliveryTerms = "delivery_terms"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// A calendar attendee's response as the provider reports it.
enum AttendeeResponse: String, Codable, Sendable, CaseIterable {
    case accepted
    case declined
    case tentative
    case needsAction = "needs_action"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

// MARK: - Phase D (docs/architecture/phase-d.md)

/// What a phone call is for (`phone.call` purpose).
enum CallPurpose: String, Codable, Sendable, CaseIterable {
    /// Deliver the user's message and record the reply.
    case message
    /// Ask which times are free on a date.
    case availability
    /// Ask the user's questions and record the answers.
    case questions
    /// Book an appointment within the approved window (binding; needs the model).
    case appointment
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// Lifecycle of one call attempt. The contract has a value `unknown` (the create-call
/// request's outcome is unknown); a value from a newer server decodes to `.unrecognized`.
enum CallStatus: String, Codable, Sendable, CaseIterable {
    case queued
    case dialing
    case ringing
    case inProgress = "in_progress"
    case ended
    /// The provider didn't confirm whether the call was placed: reconciled before any new call.
    case outcomeUnknown = "unknown"
    case unrecognized

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unrecognized)
    }

    /// Placed (or about to be) and not finished.
    var isLive: Bool {
        self == .queued || self == .dialing || self == .ringing || self == .inProgress
    }
}

/// How an ended call ended. Only `completed` and `answered` count as a call that took place.
enum CallResult: String, Codable, Sendable, CaseIterable {
    case completed
    case answered
    case busy
    case noAnswer = "no_answer"
    case failed
    case voicemail
    case hungUp = "hung_up"
    case declined
    case canceled
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }

    /// The call took place (someone answered and the conversation ended normally).
    var tookPlace: Bool { self == .completed || self == .answered }
}

/// Who spoke a call turn. `system` = a line JARVIS played that is not dialog.
enum CallSpeaker: String, Codable, Sendable, CaseIterable {
    case agent
    case callee
    case system
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// What a call turn is (for display and evidence).
enum CallTurnKind: String, Codable, Sendable, CaseIterable {
    case disclosure
    case consentRequest = "consent_request"
    case consentReply = "consent_reply"
    case question
    case answer
    case statement
    case clarification
    case refusal
    case transfer
    case voicemail
    case goodbye
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// Recording of a call; default off.
enum RecordingMode: String, Codable, Sendable, CaseIterable {
    case off
    /// Recorded only after the callee accepted; otherwise not recorded.
    case ifConsented = "if_consented"
    /// Without the callee's consent JARVIS ends the call politely.
    case required
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// The callee's answer to the recording question.
enum RecordingConsent: String, Codable, Sendable, CaseIterable {
    case notAsked = "not_asked"
    case accepted
    case declined
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// Answering-machine detection. The contract has a value `unknown` (the provider couldn't
/// tell); a value from a newer server decodes to `.unrecognized`.
enum AnsweredBy: String, Codable, Sendable, CaseIterable {
    case human
    case machine
    case fax
    case undetermined = "unknown"
    case unrecognized

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unrecognized)
    }
}

/// What JARVIS does when a machine answers.
enum VoicemailAction: String, Codable, Sendable, CaseIterable {
    case hangUp = "hang_up"
    case leaveMessage = "leave_message"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// Facts noted during a call (for the result and the timeline).
enum CallNoteCode: String, Codable, Sendable, CaseIterable {
    case optedOut = "OPTED_OUT"
    case recordingConsentAccepted = "RECORDING_CONSENT_ACCEPTED"
    case recordingConsentDeclined = "RECORDING_CONSENT_DECLINED"
    case transferRequested = "TRANSFER_REQUESTED"
    case transferConnected = "TRANSFER_CONNECTED"
    case transferFailed = "TRANSFER_FAILED"
    case transferUnavailable = "TRANSFER_UNAVAILABLE"
    case outsidePurposeRefused = "OUTSIDE_PURPOSE_REFUSED"
    case injectionFlagged = "INJECTION_FLAGGED"
    case lowConfidence = "LOW_CONFIDENCE"
    case durationLimit = "DURATION_LIMIT"
    case voicemailMessageLeft = "VOICEMAIL_MESSAGE_LEFT"
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// Where a do-not-call entry came from.
enum DoNotCallSource: String, Codable, Sendable, CaseIterable {
    /// The callee asked during a call.
    case calleeRequest = "callee_request"
    /// The user added it.
    case user
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// A verification call to the account's own number.
enum PhoneVerificationStatus: String, Codable, Sendable, CaseIterable {
    case calling
    case pending
    case verified
    case expired
    case failed
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// Voice mode: one dictated request, or a continuous conversation.
enum VoiceSessionMode: String, Codable, Sendable, CaseIterable {
    case dictation
    case conversation
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// How a voice session ended (metadata only).
enum VoiceEndReason: String, Codable, Sendable, CaseIterable {
    case endButton = "end_button"
    case escapeKey = "escape_key"
    /// "stop" / "stopp" / "توقف".
    case voiceCommand = "voice_command"
    /// No speech for `VoiceLimits.idleEndSeconds` (announced first).
    case idle
    case switchedToText = "switched_to_text"
    /// The voice screen was left.
    case navigation
    case error
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}
