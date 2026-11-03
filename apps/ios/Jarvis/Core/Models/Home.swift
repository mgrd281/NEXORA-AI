import Foundation

// Mirrors AssistantStatus / Suggestion / HomeSnapshot in packages/contracts/src/schemas.ts.

struct AssistantStatus: Decodable, Sendable, Equatable {
    struct Planner: Decodable, Sendable, Equatable {
        let mode: PlannerInfo.Mode
        let provider: String?
        /// Why the assistant is offline, e.g. NO_API_KEY or USER_DISABLED_EXTERNAL_MODELS.
        let reason: String?
    }

    struct Worker: Decodable, Sendable, Equatable {
        let healthy: Bool
        let lastHeartbeatAt: Date?
    }

    struct Capabilities: Decodable, Sendable, Equatable {
        let webFetch: Bool
        let email: Bool
        let memory: Bool
        let generalQuestions: Bool
    }

    let planner: Planner
    let worker: Worker
    let capabilities: Capabilities
    let version: String
}

struct Suggestion: Decodable, Sendable, Equatable, Identifiable {
    enum Kind: String, Codable, Sendable {
        case command
        case connect
        case review
        case unknown

        init(from decoder: any Decoder) throws {
            self = try LenientEnum.decode(decoder, fallback: .unknown)
        }
    }

    let id: String
    let kind: Kind
    /// i18n key; clients own the copy.
    let messageKey: String
    /// For `command`: text placed in the command bar (the user still submits it).
    let command: String?
    /// For `connect` / `review`: an in-app route of the web app.
    let href: String?
}

struct HomeSnapshot: Decodable, Sendable, Equatable {
    let assistant: AssistantStatus
    let pendingApprovals: [Approval]
    let activeTasks: [TaskSummary]
    let recentTasks: [TaskSummary]
    let unreadNotifications: Int
    let suggestions: [Suggestion]
}
