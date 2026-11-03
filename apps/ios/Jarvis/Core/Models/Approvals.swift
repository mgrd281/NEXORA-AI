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
    }

    struct Generic: Decodable, Sendable, Equatable {
        struct Field: Decodable, Sendable, Equatable, Hashable {
            let label: String
            let value: String
        }

        let toolId: ToolId
        let fields: [Field]
    }

    case email(Email)
    case generic(Generic)
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
        default:
            self = .unknown(kind: kind)
        }
    }
}

struct Approval: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let taskId: String
    let taskTitle: String
    let stepId: String
    let toolId: ToolId
    let status: ApprovalStatus
    let riskLevel: RiskLevel
    /// Exactly what will happen, in one sentence.
    let summary: String
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
        if case .unknown = details { return false }
        return true
    }
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
