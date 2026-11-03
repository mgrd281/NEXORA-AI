import Foundation

/// Client-owned copy for server-provided keys (suggestions, planner reasons). The server
/// never authors user-facing text, so unknown keys are hidden rather than shown raw.
enum HomeCopy {
    struct SuggestionText {
        let message: String
        /// Localized example placed in the command bar (for `command` suggestions).
        let command: String?
        /// Whether the suggestion leads to Settings in this app.
        let opensSettings: Bool
    }

    static func suggestion(_ suggestion: Suggestion) -> SuggestionText? {
        switch suggestion.messageKey {
        case "suggest.enableWeb":
            SuggestionText(
                message: String(localized: "Web access is off, so JARVIS can't read public web pages yet. Turn it on in JARVIS on the web."),
                command: nil,
                opensSettings: true
            )
        case "suggest.connectEmail":
            SuggestionText(
                message: String(localized: "No working mailbox is connected, so JARVIS can't send email yet. Connect one in JARVIS on the web."),
                command: nil,
                opensSettings: true
            )
        case "suggest.configureModel":
            SuggestionText(
                message: String(localized: "JARVIS is running its offline rules engine. It handles simple, well-defined requests."),
                command: nil,
                opensSettings: true
            )
        case "suggest.summarizeAndEmail":
            SuggestionText(
                message: String(localized: "Try: summarize a web page and email it to yourself."),
                command: String(localized: "Summarize https://example.com and email it to me"),
                opensSettings: false
            )
        case "suggest.remember":
            SuggestionText(
                message: String(localized: "Tell JARVIS something to remember."),
                command: String(localized: "Remember that I prefer short answers"),
                opensSettings: false
            )
        default:
            nil
        }
    }

    static func plannerNotice(_ status: AssistantStatus) -> String? {
        guard status.planner.mode == .offline else { return nil }
        switch status.planner.reason {
        case "NO_API_KEY":
            return String(localized: "No AI model is configured on the server, so JARVIS uses its offline rules engine for simple, well-defined requests.")
        case "USER_DISABLED_EXTERNAL_MODELS":
            return String(localized: "You turned off external AI models, so JARVIS uses its offline rules engine for simple, well-defined requests.")
        case "BUDGET_EXHAUSTED":
            return String(localized: "Your monthly AI budget is used up, so JARVIS uses its offline rules engine until next month.")
        default:
            return String(localized: "JARVIS is using its offline rules engine for simple, well-defined requests.")
        }
    }

    static func workerNotice(_ status: AssistantStatus) -> String? {
        guard !status.worker.healthy else { return nil }
        return String(localized: "JARVIS's background worker isn't responding, so new tasks may wait in the queue.")
    }

    static func greeting(name: String, timeZone identifier: String, now: Date = Date()) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: identifier) ?? .current
        let hour = calendar.component(.hour, from: now)
        let first = name.split(separator: " ").first.map(String.init) ?? name
        switch hour {
        case 5..<12: return String(localized: "Good morning, \(first)")
        case 12..<18: return String(localized: "Good afternoon, \(first)")
        default: return String(localized: "Good evening, \(first)")
        }
    }
}
