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
        // Phase B. Always sent by the current API; nil from older servers (unknown).
        /// File uploads work (storage configured and the document-analysis skill on).
        var attachments: Bool? = nil
        /// Translation can run now (needs a model).
        var translation: Bool? = nil
        /// Schedules can be created (task-scheduling skill on).
        var schedules: Bool? = nil
        // Phase C. Each is true only when the tools are built on the server, the skill is on
        // and what it needs is connected / running; nil from older servers (unknown).
        /// Reading, drafting and tracking mail through a Google / Microsoft account.
        var mail: Bool? = nil
        /// Reading and changing a connected calendar.
        var calendar: Bool? = nil
        /// The isolated browser agent is running.
        var browser: Bool? = nil
        /// Finding and booking appointments on supported sites.
        var booking: Bool? = nil
        /// Comparing products on supported shops.
        var shopping: Bool? = nil
        /// Purchases are possible at all (shopping available and a purchase limit above 0).
        var purchases: Bool? = nil
        // Phase D; nil from older servers (unknown).
        /// Phone calls can be placed (phone.call built, telephony configured, the skill on).
        var phoneCalls: Bool? = nil
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
    /// Phase C: the next events of the connected calendars; nil (or absent, from older
    /// servers) when no connection grants calendar.read — Home then shows no "Upcoming".
    var upcoming: UpcomingEvents? = nil
}
