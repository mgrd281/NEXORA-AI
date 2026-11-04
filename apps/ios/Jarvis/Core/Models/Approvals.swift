import Foundation

// Mirrors Approval / ApprovalDetails / ApprovalDecisionRequest in packages/contracts/src/schemas.ts.

/// Exactly what an approval would allow, as the server will execute it.
/// Discriminated by `kind`; a kind this build does not know decodes to `.unknown`
/// and is never approvable from this app (the user cannot see what it would do).
enum ApprovalDetails: Decodable, Sendable, Equatable {
    struct Email: Decodable, Sendable, Equatable {
        let from: String
        let to: [String]
        let subject: String
        let body: String
        var untrusted: UntrustedSource? = nil
    }

    struct Generic: Decodable, Sendable, Equatable {
        struct Field: Decodable, Sendable, Equatable, Hashable {
            let label: String
            let value: String
        }

        let toolId: ToolId
        let fields: [Field]
        var untrusted: UntrustedSource? = nil
    }

    /// `schedule.create`: future runs, each planned and checked by the policy when it happens.
    struct ScheduleAction: Decodable, Sendable, Equatable {
        let title: String
        /// The request each run will carry out, exactly as it will be stored.
        let request: String
        let recurrence: Recurrence
        let rrule: String
        /// The first runs, as instants (shown in `recurrence.timeZone`).
        let nextOccurrences: [Date]
        var untrusted: UntrustedSource? = nil
    }

    /// `memory.save` of text that came from an earlier result: exactly what will be kept.
    struct MemoryAction: Decodable, Sendable, Equatable {
        let content: String
        let memoryKind: MemoryKind
        /// The task whose result the text came from.
        let sourceTaskId: String?
        var untrusted: UntrustedSource? = nil
    }

    case email(Email)
    case generic(Generic)
    case schedule(ScheduleAction)
    case memory(MemoryAction)
    case unknown(kind: String)

    private enum CodingKeys: String, CodingKey {
        case kind
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "email":
            self = .email(try Email(from: decoder))
        case "generic":
            self = .generic(try Generic(from: decoder))
        case "schedule":
            self = .schedule(try ScheduleAction(from: decoder))
        case "memory":
            self = .memory(try MemoryAction(from: decoder))
        default:
            self = .unknown(kind: kind)
        }
    }

    /// Facts about content flagged as a suspected prompt injection that this action uses.
    var untrusted: UntrustedSource? {
        switch self {
        case .email(let email): email.untrusted
        case .generic(let generic): generic.untrusted
        case .schedule(let schedule): schedule.untrusted
        case .memory(let memory): memory.untrusted
        case .unknown: nil
        }
    }
}

/// `UntrustedSource`: never contains the flagged text itself.
struct UntrustedSource: Decodable, Sendable, Equatable {
    /// Host of the page the content came from, when it came from a web page.
    let host: String?
    let excludedSentences: Int?
    /// Detector signal ids, e.g. ignore_previous_instructions.
    let signals: [String]
}

struct Approval: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let taskId: String
    let taskTitle: String
    var taskTitleMessage: ServerMessage? = nil
    let stepId: String
    let toolId: ToolId
    let status: ApprovalStatus
    let riskLevel: RiskLevel
    /// Exactly what will happen, in one sentence (request language; see `summaryMessage`).
    let summary: String
    var summaryMessage: ServerMessage? = nil
    let details: ApprovalDetails
    /// Binds the decision to the exact action shown; sent back when deciding.
    let actionHash: String
    let reasons: [String]
    let expiresAt: Date
    let decidedAt: Date?
    let decisionNote: String?
    let createdAt: Date

    func isExpired(at now: Date = Date()) -> Bool {
        status == .expired || (status == .pending && expiresAt <= now)
    }

    /// Whether this app can show the action precisely enough to let the user approve it.
    var isReviewable: Bool {
        switch details {
        case .unknown: false
        case .schedule(let action): action.recurrence.isFullyKnown
        case .memory(let action): action.memoryKind != .unknown
        case .email, .generic: true
        }
    }

    var displaySummary: String { summaryMessage.rendered(or: summary) }
    var displayTaskTitle: String { taskTitleMessage.rendered(or: taskTitle) }
}

enum ApprovalDecision: String, Encodable, Sendable {
    case approve
    case reject
}

/// `POST /v1/approvals/:id/decision`.
struct ApprovalDecisionRequest: Encodable, Sendable, Equatable {
    let decision: ApprovalDecision
    let actionHash: String
    let note: String?
}
