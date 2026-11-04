import Foundation

// Mirrors `ServerMessage` in packages/contracts/src/schemas.ts.
//
// Some sentences are composed by the server (offline plan and step titles, objectives,
// approval summaries, result lines, clarifying questions). They arrive as a key plus
// parameters next to the text the server rendered in the request's language, so the app
// can show them in its own language. A key this build does not know renders as nil and
// the caller falls back to the server's text.

/// A server sentence as data: `{ key, params }`.
struct ServerMessage: Decodable, Sendable, Equatable {
    let key: String
    let params: [String: ServerMessageParam]

    init(key: String, params: [String: ServerMessageParam] = [:]) {
        self.key = key
        self.params = params
    }

    private enum CodingKeys: String, CodingKey {
        case key
        case params
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decode(String.self, forKey: .key)
        params = try container.decodeIfPresent([String: ServerMessageParam].self, forKey: .params) ?? [:]
    }

    /// The sentence in the app's language, or nil when this build cannot render it.
    var rendered: String? { ServerMessageText.render(self) }
}

/// A parameter of a server sentence: a string, a number or a nested sentence.
enum ServerMessageParam: Decodable, Sendable, Equatable {
    case text(String)
    case number(Double)
    indirect case message(ServerMessage)
    /// A value of a shape this build does not know (never rendered).
    case unsupported

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self = .text(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(ServerMessage.self) {
            self = .message(value)
        } else {
            self = .unsupported
        }
    }
}

extension Optional where Wrapped == ServerMessage {
    /// The message in the app's language, else the server's text (request language).
    func rendered(or fallback: String) -> String {
        switch self {
        case .some(let message): message.rendered ?? fallback
        case .none: fallback
        }
    }
}

/// Bidi isolation (FSI … PDI), so a value in another script keeps its own direction
/// inside a sentence, for example an English host name in an Arabic sentence.
extension String {
    var bidiIsolated: String { "\u{2068}\(self)\u{2069}" }
}

/// Renders every `ServerMessageKey` in the app's language. The English default values and
/// the de/ar catalog entries (keys `server.<key>`) mirror the server's canonical templates in
/// apps/api/src/modules/agent/i18n.ts; scripts/check-server-messages.ts verifies both.
enum ServerMessageText {
    static func render(_ message: ServerMessage) -> String? {
        let p = ServerMessageParams(message.params)
        let text: String
        switch message.key {
        // Offline plan titles
        case "plan.summarize":
            text = String(localized: "server.plan.summarize", defaultValue: "Summarize \(p.host)")
        case "plan.summarizeEmail":
            text = String(localized: "server.plan.summarizeEmail", defaultValue: "Summarize \(p.host) and email it to you")
        case "plan.remember":
            text = String(localized: "server.plan.remember", defaultValue: "Remember: \(p.text)")
        case "plan.emailSelf":
            text = String(localized: "server.plan.emailSelf", defaultValue: "Email yourself: \(p.text)")
        // Offline plan objectives
        case "objective.summarize":
            text = String(localized: "server.objective.summarize", defaultValue: "Read \(p.url) and summarize it.")
        case "objective.summarizeEmail":
            text = String(localized: "server.objective.summarizeEmail", defaultValue: "Read \(p.url), summarize it and email the summary to \(p.email).")
        case "objective.remember":
            text = String(localized: "server.objective.remember", defaultValue: "Save a note to long-term memory.")
        case "objective.emailSelf":
            text = String(localized: "server.objective.emailSelf", defaultValue: "Send a note to \(p.email).")
        // Offline step titles
        case "step.fetch":
            text = String(localized: "server.step.fetch", defaultValue: "Read \(p.host)")
        case "step.summarize":
            text = String(localized: "server.step.summarize", defaultValue: "Summarize the page")
        case "step.emailSummary":
            text = String(localized: "server.step.emailSummary", defaultValue: "Email the summary to you")
        case "step.remember":
            text = String(localized: "server.step.remember", defaultValue: "Save to memory")
        case "step.emailNote":
            text = String(localized: "server.step.emailNote", defaultValue: "Email the note to you")
        // Approval summaries
        case "approval.email":
            text = String(localized: "server.approval.email", defaultValue: "Send the email “\(p.subject)” to \(p.recipients).")
        case "approval.generic":
            text = String(localized: "server.approval.generic", defaultValue: "Run “\(p.title)” (\(p.tool)).")
        case "approval.recipientsMany":
            text = String(localized: "server.approval.recipientsMany", defaultValue: "\(p.count) recipients")
        // Result lines
        case "result.emailSent":
            text = String(localized: "server.result.emailSent", defaultValue: "Sent “\(p.subject)” to \(p.recipients).")
        case "result.memorySaved":
            text = String(localized: "server.result.memorySaved", defaultValue: "Saved to memory: “\(p.text)”.")
        case "result.declined":
            text = String(localized: "server.result.declined", defaultValue: "You declined this action, so nothing was sent or changed: \(p.action)")
        case "result.cancelled":
            text = String(localized: "server.result.cancelled", defaultValue: "Cancelled at your request.")
        case "result.expired":
            text = String(localized: "server.result.expired", defaultValue: "The approval request expired before you decided, so nothing was done.")
        // Phase B: plan titles
        case "plan.emailResult":
            text = String(localized: "server.plan.emailResult", defaultValue: "Email “\(p.title)” to you")
        case "plan.rememberResult":
            text = String(localized: "server.plan.rememberResult", defaultValue: "Remember the result of “\(p.title)”")
        case "plan.summarizeDocument":
            text = String(localized: "server.plan.summarizeDocument", defaultValue: "Summarize \(p.name)")
        case "plan.schedule":
            text = String(localized: "server.plan.schedule", defaultValue: "Schedule: \(p.title)")
        case "plan.clarify":
            text = String(localized: "server.plan.clarify", defaultValue: "Question about your request")
        // Phase B: objectives
        case "objective.emailResult":
            text = String(localized: "server.objective.emailResult", defaultValue: "Send the earlier result to \(p.email).")
        case "objective.rememberResult":
            text = String(localized: "server.objective.rememberResult", defaultValue: "Save the earlier result to long-term memory.")
        case "objective.summarizeDocument":
            text = String(localized: "server.objective.summarizeDocument", defaultValue: "Read \(p.name) and summarize it.")
        case "objective.schedule":
            text = String(localized: "server.objective.schedule", defaultValue: "Create the schedule “\(p.title)”.")
        case "objective.clarify":
            text = String(localized: "server.objective.clarify", defaultValue: "Ask you for the information this request needs.")
        // Phase B: step titles
        case "step.recall":
            text = String(localized: "server.step.recall", defaultValue: "Get the earlier result")
        case "step.emailResult":
            text = String(localized: "server.step.emailResult", defaultValue: "Email it to you")
        case "step.summarizeDocument":
            text = String(localized: "server.step.summarizeDocument", defaultValue: "Summarize \(p.name)")
        case "step.schedule":
            text = String(localized: "server.step.schedule", defaultValue: "Create the schedule")
        case "step.clarify":
            text = String(localized: "server.step.clarify", defaultValue: "Ask you for details")
        // Phase B: approval summaries
        case "approval.schedule":
            text = String(localized: "server.approval.schedule", defaultValue: "Create the schedule “\(p.title)”.")
        case "approval.memory":
            text = String(localized: "server.approval.memory", defaultValue: "Save to memory: “\(p.text)”.")
        // Phase B: result lines
        case "result.scheduleCreated":
            text = String(localized: "server.result.scheduleCreated", defaultValue: "Created the schedule “\(p.title)”.")
        case "result.documentSummarized":
            text = String(localized: "server.result.documentSummarized", defaultValue: "Summarized \(p.name).")
        // Phase B: clarifying questions
        case "question.emailContent":
            text = String(localized: "server.question.emailContent", defaultValue: "What should the email say?")
        case "question.recipient":
            text = String(localized: "server.question.recipient", defaultValue: "Who should receive it? Write their email address.")
        case "question.url":
            text = String(localized: "server.question.url", defaultValue: "Which page should I read? Paste its link.")
        case "question.document":
            text = String(localized: "server.question.document", defaultValue: "Which document do you mean? Attach the file.")
        case "question.scheduleTime":
            text = String(localized: "server.question.scheduleTime", defaultValue: "When should this run? For example: every Monday at 9:00.")
        case "question.targetLanguage":
            text = String(localized: "server.question.targetLanguage", defaultValue: "Which language should I translate it into?")
        case "question.previousResult":
            text = String(localized: "server.question.previousResult", defaultValue: "There is no earlier result in this conversation I could use. What should I send or save?")
        case "question.details":
            text = String(localized: "server.question.details", defaultValue: "Can you tell me more about what you need?")
        default:
            return nil
        }
        return p.isComplete ? text : nil
    }
}

/// Parameter lookup for `ServerMessageText`: renders each value for display (numbers in the
/// app's locale, tool and skill ids by name, nested messages recursively), isolates it for
/// bidi, and records whether anything was missing so the caller can fall back.
@dynamicMemberLookup
final class ServerMessageParams {
    private let values: [String: ServerMessageParam]
    private(set) var isComplete = true

    init(_ values: [String: ServerMessageParam]) {
        self.values = values
    }

    subscript(dynamicMember name: String) -> String {
        guard let value = values[name], let text = Self.display(value, name: name) else {
            isComplete = false
            return ""
        }
        return text.bidiIsolated
    }

    static func display(_ value: ServerMessageParam, name: String) -> String? {
        switch value {
        case .text(let text):
            if name == "tool", let tool = ToolId(rawValue: text), tool != .unknown { return tool.label }
            if name == "skill", let skill = SkillId(rawValue: text), skill != .unknown { return skill.name }
            return text
        case .number(let number):
            return Self.format(number)
        case .message(let message):
            return ServerMessageText.render(message)
        case .unsupported:
            return nil
        }
    }

    static func format(_ number: Double) -> String {
        if number.rounded() == number, abs(number) < 1e15 {
            return Int64(number).formatted()
        }
        return number.formatted()
    }
}
