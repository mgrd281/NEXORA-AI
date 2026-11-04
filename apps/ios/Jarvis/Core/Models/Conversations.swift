import Foundation

// Mirrors the "Conversations (Phase B)" section of packages/contracts/src/schemas.ts.

/// A message of a conversation: the user's request of a task, or what JARVIS said when the
/// task completed (its answer, clarifying question or result line).
struct ConversationMessage: Decodable, Sendable, Equatable, Identifiable {
    enum Role: String, Codable, Sendable {
        case user
        case assistant
        case unknown

        init(from decoder: any Decoder) throws {
            self = try LenientEnum.decode(decoder, fallback: .unknown)
        }
    }

    let id: String
    let role: Role
    let kind: MessageKind
    /// User text, model text, or the server sentence rendered in the request language.
    let text: String
    /// Set when the server composed the text: shown in the app's language.
    let textMessage: ServerMessage?
    let language: AppLocale?
    let taskId: String?
    /// Files attached to a request (user messages); empty otherwise.
    let attachments: [Attachment]
    let createdAt: Date

    var displayText: String { textMessage.rendered(or: text) }
}

/// One entry of a conversation thread. Per task, in order: the user's request, the task,
/// and (once it completed) JARVIS's message. An entry type this build does not know
/// decodes to `.unknown` and is not shown.
enum ConversationTurn: Decodable, Sendable, Equatable {
    case userMessage(ConversationMessage)
    case task(TaskSummary)
    case assistantMessage(ConversationMessage)
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        case type
        case message
        case task
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "user_message":
            self = .userMessage(try container.decode(ConversationMessage.self, forKey: .message))
        case "task":
            self = .task(try container.decode(TaskSummary.self, forKey: .task))
        case "assistant_message":
            self = .assistantMessage(try container.decode(ConversationMessage.self, forKey: .message))
        default:
            self = .unknown(type: type)
        }
    }

    /// Stable identity for lists (turns have no id of their own).
    var stableId: String? {
        switch self {
        case .userMessage(let message): "user-\(message.id)"
        case .task(let task): "task-\(task.id)"
        case .assistantMessage(let message): "assistant-\(message.id)"
        case .unknown: nil
        }
    }

    /// The task this turn belongs to.
    var taskId: String? {
        switch self {
        case .userMessage(let message), .assistantMessage(let message): message.taskId
        case .task(let task): task.id
        case .unknown: nil
        }
    }
}

struct ConversationSummary: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    /// In the first request's language; see `titleMessage`.
    let title: String
    let titleMessage: ServerMessage?
    let taskCount: Int
    /// The newest task.
    let lastTask: TaskSummary?
    /// A task of the conversation is still queued, planning, waiting for approval or running.
    let hasActiveTask: Bool
    /// Set for the conversation that collects a schedule's runs.
    let scheduleId: String?
    let createdAt: Date
    /// Last activity (a new task, message or title).
    let updatedAt: Date

    var displayTitle: String { titleMessage.rendered(or: title) }
}

/// `GET /v1/conversations/:id`: the newest page of turns plus whether a follow-up is possible.
struct ConversationDetail: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let title: String
    let titleMessage: ServerMessage?
    let taskCount: Int
    let lastTask: TaskSummary?
    let hasActiveTask: Bool
    let scheduleId: String?
    let createdAt: Date
    let updatedAt: Date
    /// The newest `limit` tasks' turns, oldest first.
    let turns: [ConversationTurn]
    /// Pass as `before` to load earlier turns; nil when there are none.
    let earlierCursor: String?
    /// Every task of the conversation has finished, so a follow-up can be sent now.
    let canFollowUp: Bool
    /// The task that has to finish (or be decided or cancelled) before a follow-up.
    let activeTaskId: String?

    var displayTitle: String { titleMessage.rendered(or: title) }
}
