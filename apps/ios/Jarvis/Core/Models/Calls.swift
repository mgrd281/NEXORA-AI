import Foundation

// Mirrors the Phase D phone-call shapes in packages/contracts/src/schemas.ts
// (docs/architecture/phase-d.md §3.2, §6). JARVIS's lines are verbatim; everything the callee
// said is the provider's speech recognition — untrusted text that the app shows isolated and
// marked, and never acts on.

/// An HH:MM window in a stated time zone's wall clock (`{ start, end }` of LocalTime values).
struct LocalTimeWindow: Decodable, Sendable, Equatable, Hashable {
    let start: String
    let end: String
}

/// Exactly what JARVIS says on a call, in the call's language, fixed at planning so the
/// approval (and its action hash) covers the exact words.
struct CallScript: Decodable, Sendable, Equatable {
    /// Always first: says that an AI assistant is calling and on whose behalf.
    let opening: String
    /// Asked right after the opening when recording isn't off.
    let recordingQuestion: String?
    /// The message delivered (purpose `message`).
    let message: String?
    /// The questions as spoken, in order.
    let questions: [String]
    /// Said before hanging up.
    let closing: String
    /// Left on an answering machine (voicemail `leave_message` only).
    let voicemailMessage: String?
}

/// A personal detail JARVIS may tell the callee — exactly this label and value, nothing else.
struct CallShareItem: Decodable, Sendable, Equatable, Hashable {
    let label: String
    let value: String
}

/// One utterance of a call.
struct CallTurn: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    /// 0, 1, 2 … in the order spoken.
    let sequence: Int
    let speaker: CallSpeaker
    let kind: CallTurnKind
    /// Verbatim for JARVIS; the provider's recognition of the callee (untrusted).
    let text: String
    let language: AppLocale
    /// Recognition confidence 0–1 (callee turns); nil otherwise.
    let confidence: Double?
    /// The callee's words contained instructions to AI assistants (ignored).
    let flagged: Bool
    let at: Date

    /// Below `CallLimits.minConfidence`: JARVIS asked again rather than rely on it.
    var isUncertain: Bool {
        guard speaker == .callee, let confidence else { return false }
        return confidence < CallLimits.minConfidence
    }
}

/// One status change of a call as the provider reported it (or JARVIS decided).
struct CallStatusEvent: Decodable, Sendable, Equatable {
    let status: CallStatus
    /// The provider's status word ("ringing", "no-answer" …); nil for JARVIS's own entries.
    let providerStatus: String?
    /// The provider's callback sequence number; nil for JARVIS's own entries.
    let sequence: Int?
    let at: Date
}

/// What a call collected — only what the callee said explicitly (their words: untrusted).
struct CallCollectedDetails: Decodable, Sendable, Equatable {
    struct Appointment: Decodable, Sendable, Equatable {
        /// YYYY-MM-DD in the callee's zone.
        let date: String
        /// HH:MM in the callee's zone.
        let time: String
        let name: String?
        let reference: String?
    }

    struct Answer: Decodable, Sendable, Equatable {
        let question: String
        /// nil: not answered.
        let answer: String?
    }

    /// The date discussed (YYYY-MM-DD, callee's zone).
    let date: String?
    /// Times the callee offered on that date (HH:MM, callee's zone).
    let times: [String]
    /// What the callee confirmed (purpose `appointment`); nil when nothing was agreed.
    let appointment: Appointment?
    /// The callee's reply (purpose `message`).
    let reply: String?
    let answers: [Answer]

    var isEmpty: Bool {
        date == nil && times.isEmpty && appointment == nil && (reply ?? "").isEmpty && answers.isEmpty
    }
}

/// The structured result of an ended call.
struct CallOutcome: Decodable, Sendable, Equatable {
    let result: CallResult
    /// The approved goal was reached (only with evidence in the turns).
    let goalReached: Bool
    let details: CallCollectedDetails
    let notes: [CallNoteCode]
    /// The result line, rendered in the app's language.
    let summaryMessage: ServerMessage?
}

/// One call attempt of a `phone.call` step (a retry after busy or no answer is a new attempt).
///
/// Also the shape of `GET /v1/calls` items (`CallSummary` = this without `turns` and
/// `timeline`), so both decode as empty lists when absent. Lists never show turns.
struct CallSession: Decodable, Sendable, Equatable, Identifiable {
    struct Recording: Decodable, Sendable, Equatable {
        let mode: RecordingMode
        let consent: RecordingConsent
        let consentAt: Date?
        /// The stored recording; nil unless recorded with the callee's consent.
        let artifactId: String?
    }

    struct Transfer: Decodable, Sendable, Equatable {
        enum Status: String, Codable, Sendable {
            /// No transfer was asked for (`none`; renamed so it never reads as Optional.none).
            case notRequested = "none"
            case requested
            case connected
            case failed
            case unavailable
            case unknown

            init(from decoder: any Decoder) throws {
                self = try LenientEnum.decode(decoder, fallback: .unknown)
            }
        }

        let status: Status
        let at: Date?
    }

    let id: String
    let taskId: String
    let stepId: String
    /// 1, 2 … per step.
    let attempt: Int
    /// E.164 as dialled (the user's own input).
    let to: String
    let toDisplay: String
    let calleeName: String?
    let language: AppLocale
    let purpose: CallPurpose
    let status: CallStatus
    /// Set when ended.
    let result: CallResult?
    let outcome: CallOutcome?
    let provider: String
    /// The provider's call id (evidence); nil until the provider accepted the call.
    let providerCallSid: String?
    let answeredBy: AnsweredBy?
    /// When the opening (AI disclosure) was spoken; nil if the call never got that far.
    let aiDisclosedAt: Date?
    let recording: Recording
    let transfer: Transfer
    /// Oldest first (empty in list items).
    let timeline: [CallStatusEvent]
    let durationSeconds: Int?
    let maxDurationSeconds: Int
    let costEstimate: Money?
    /// The provider's price once it reports one.
    let price: Money?
    /// Why the attempt didn't reach its goal (`TaskErrorReason`; a string so newer ones decode).
    let failureReason: String?
    /// Oldest first (empty in list items; a task shows at most `CallLimits.turnsInTaskDetail`).
    let turns: [CallTurn]
    let dialedAt: Date?
    let answeredAt: Date?
    let endedAt: Date?
    let createdAt: Date
    let updatedAt: Date
    /// List items (`GET /v1/calls`) only: the task's title; see `taskTitleMessage`.
    let taskTitle: String?
    /// Set when the server wrote the task's title: render it in the app's language.
    let taskTitleMessage: ServerMessage?

    private enum CodingKeys: String, CodingKey {
        case id, taskId, stepId, attempt, to, toDisplay, calleeName, language, purpose, status
        case result, outcome, provider, providerCallSid, answeredBy, aiDisclosedAt, recording
        case transfer, timeline, durationSeconds, maxDurationSeconds, costEstimate, price
        case failureReason, turns, dialedAt, answeredAt, endedAt, createdAt, updatedAt
        case taskTitle, taskTitleMessage
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        taskId = try c.decode(String.self, forKey: .taskId)
        stepId = try c.decode(String.self, forKey: .stepId)
        attempt = try c.decode(Int.self, forKey: .attempt)
        to = try c.decode(String.self, forKey: .to)
        toDisplay = try c.decode(String.self, forKey: .toDisplay)
        calleeName = try c.decodeIfPresent(String.self, forKey: .calleeName)
        language = try c.decode(AppLocale.self, forKey: .language)
        purpose = try c.decode(CallPurpose.self, forKey: .purpose)
        status = try c.decode(CallStatus.self, forKey: .status)
        result = try c.decodeIfPresent(CallResult.self, forKey: .result)
        outcome = try c.decodeIfPresent(CallOutcome.self, forKey: .outcome)
        provider = try c.decode(String.self, forKey: .provider)
        providerCallSid = try c.decodeIfPresent(String.self, forKey: .providerCallSid)
        answeredBy = try c.decodeIfPresent(AnsweredBy.self, forKey: .answeredBy)
        aiDisclosedAt = try c.decodeIfPresent(Date.self, forKey: .aiDisclosedAt)
        recording = try c.decode(Recording.self, forKey: .recording)
        transfer = try c.decode(Transfer.self, forKey: .transfer)
        timeline = try c.decodeIfPresent([CallStatusEvent].self, forKey: .timeline) ?? []
        durationSeconds = try c.decodeIfPresent(Int.self, forKey: .durationSeconds)
        maxDurationSeconds = try c.decode(Int.self, forKey: .maxDurationSeconds)
        costEstimate = try c.decodeIfPresent(Money.self, forKey: .costEstimate)
        price = try c.decodeIfPresent(Money.self, forKey: .price)
        failureReason = try c.decodeIfPresent(String.self, forKey: .failureReason)
        turns = try c.decodeIfPresent([CallTurn].self, forKey: .turns) ?? []
        dialedAt = try c.decodeIfPresent(Date.self, forKey: .dialedAt)
        answeredAt = try c.decodeIfPresent(Date.self, forKey: .answeredAt)
        endedAt = try c.decodeIfPresent(Date.self, forKey: .endedAt)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        taskTitle = try c.decodeIfPresent(String.self, forKey: .taskTitle)
        taskTitleMessage = try c.decodeIfPresent(ServerMessage.self, forKey: .taskTitleMessage)
    }

    /// The task's title for a list row (nil when the server didn't send one).
    var displayTaskTitle: String? {
        guard let taskTitle else { return nil }
        return taskTitleMessage.rendered(or: taskTitle)
    }

    /// The callee as the user named them, else the readable number.
    var displayName: String {
        if let name = calleeName, !name.isEmpty { return name }
        return toDisplay
    }

    /// Recorded audio exists only with the callee's consent (and the user asked for it).
    var hasConsentedRecording: Bool {
        recording.consent == .accepted && recording.artifactId != nil
    }
}

/// `GET /v1/calls` items: a call without its turns and status timeline.
typealias CallSummary = CallSession

/// A number JARVIS won't call for this account (masked; only a keyed hash is stored).
struct DoNotCallEntry: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    /// Masked, e.g. "+49 30 ••• •• 67".
    let number: String
    /// ISO 3166-1 alpha-2; nil when unknown.
    let country: String?
    let source: DoNotCallSource
    /// The call during which the callee asked.
    let callId: String?
    /// The task of that call (nil once deleted, or from an older server).
    var taskId: String? = nil
    let createdAt: Date
}

/// A verification call that reads a code to the account's own number.
struct PhoneVerification: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let status: PhoneVerificationStatus
    /// The number being verified, masked.
    let number: String
    let attemptsLeft: Int
    let expiresAt: Date
    let createdAt: Date
}

/// `GET /v1/me/phone/verification`: the verification to resume (calling, pending or failed,
/// before it expires), else nil.
struct PhoneVerificationState: Decodable, Sendable, Equatable {
    let verification: PhoneVerification?
}

/// `POST /v1/me/phone/verification/confirm`.
struct ConfirmPhoneVerificationRequest: Encodable, Sendable, Equatable {
    let code: String
}

/// The `CALL_LIMITS` values the app relies on (packages/contracts/src/limits.ts;
/// scripts/check-contract-copy.ts verifies they match).
enum CallLimits {
    static let minConfidence = 0.5
    static let verificationCodeLength = 6
    static let turnsInTaskDetail = 40
}
