import Foundation

/// Localized one-line descriptions of task history events, using the event data shapes
/// documented in apps/api/src/modules/events/events.ts.
enum TaskEventText {
    static func describe(_ type: EventType, data: [String: JSONValue]) -> String {
        // The step title in the app's language when the server wrote it, else as stored.
        let title = ServerMessage(json: data["titleMessage"])
            .rendered(or: data["title"]?.stringValue ?? "")
            .bidiIsolated
        switch type {
        case .taskCreated:
            return String(localized: "Task created")
        case .taskStatusChanged:
            let status = data["to"]?.stringValue.flatMap(TaskStatus.init(rawValue:)) ?? .unknown
            return String(localized: "Status: \(status.label)")
        case .planReady:
            return String(localized: "Plan ready")
        case .stepStarted:
            return String(localized: "Started: \(title)")
        case .stepSucceeded:
            return String(localized: "Finished: \(title)")
        case .stepFailed:
            return String(localized: "Failed: \(title)")
        case .stepBlocked:
            return String(localized: "Blocked by policy: \(title)")
        case .approvalRequested:
            return String(localized: "Approval requested")
        case .approvalDecided:
            switch data["decision"]?.stringValue {
            case "approved": return String(localized: "You approved the action")
            case "rejected": return String(localized: "You declined the action")
            case "expired": return String(localized: "The approval expired")
            default: return String(localized: "Approval decided")
            }
        case .verificationPassed:
            return String(localized: "Result verified")
        case .verificationFailed:
            return String(localized: "Verification failed")
        case .taskAnswerDelta:
            return String(localized: "Answer updated")
        case .taskCancelRequested:
            return String(localized: "Cancellation requested")
        case .taskRetried:
            return String(localized: "Retried")
        case .notificationCreated, .connectionChanged, .heartbeat, .conversationMessage,
             .conversationChanged, .scheduleChanged, .webhookDeliveryFailed, .webhookEndpointChanged,
             .emailWatchChanged, .browserSessionChanged, .orderChanged, .bookingChanged, .unknown:
            return String(localized: "Update")
        }
    }

    static func icon(_ type: EventType) -> String {
        switch type {
        case .taskCreated: "plus.circle"
        case .taskStatusChanged: "arrow.right.circle"
        case .planReady: MeridianIcon.status(.planning)
        case .stepStarted: "play.circle"
        case .stepSucceeded, .verificationPassed: "checkmark.circle"
        case .stepFailed, .verificationFailed: "exclamationmark.circle"
        case .stepBlocked: "nosign"
        case .approvalRequested, .approvalDecided: "hand.raised"
        case .taskCancelRequested: "slash.circle"
        case .taskRetried: "arrow.clockwise.circle"
        case .taskAnswerDelta, .notificationCreated, .connectionChanged, .heartbeat, .conversationMessage,
             .conversationChanged, .scheduleChanged, .webhookDeliveryFailed, .webhookEndpointChanged,
             .emailWatchChanged, .browserSessionChanged, .orderChanged, .bookingChanged, .unknown: "circle"
        }
    }
}

/// Localized explanations for policy reason codes (apps/api/src/modules/agent/policy.ts).
enum PolicyReasonText {
    static func describe(_ code: String) -> String? {
        switch code {
        case "RISK_LOW": String(localized: "Low-risk action.")
        case "RISK_MEDIUM": String(localized: "Medium-risk action: it has an effect outside JARVIS.")
        case "RISK_HIGH": String(localized: "High-risk action: it always needs your approval.")
        case "RISK_CRITICAL": String(localized: "Critical-risk actions are not allowed in this version.")
        case "RECIPIENT_SELF": String(localized: "The email goes only to your own address.")
        case "RECIPIENT_EXTERNAL": String(localized: "It goes to someone other than you.")
        case "MANY_RECIPIENTS": String(localized: "It goes to more than three people.")
        case "AUTO_APPROVED_SELF": String(localized: "Approved automatically by your setting for emails to yourself.")
        case "CONNECTION_MISSING": String(localized: "A required service isn't connected.")
        case "MEMORY_DISABLED": String(localized: "Memory is turned off in your settings.")
        case "EXTERNAL_MODELS_DISABLED": String(localized: "External AI models are turned off in your settings.")
        case "MODEL_UNAVAILABLE": String(localized: "No AI model is available for this step.")
        case "BUDGET_ZERO": String(localized: "Your monthly AI budget is set to zero.")
        case "BUDGET_EXHAUSTED": String(localized: "Your monthly AI budget is used up.")
        case "BUDGET_NEAR_LIMIT": String(localized: "This could exceed what's left of your monthly AI budget.")
        case "UNTRUSTED_CONTENT": String(localized: "It uses web content that looked like it was trying to instruct JARVIS.")
        case "SKILL_DISABLED": String(localized: "The skill this needs is turned off in Settings.")
        case "SKILL_COST_LIMIT": String(localized: "This could cost more than the skill's limit per run.")
        case "MEMORY_FROM_CONTENT": String(localized: "The text to remember comes from an earlier result, so you decide exactly what is kept.")
        case "UNTRUSTED_MEMORY": String(localized: "The text comes from content that tried to instruct JARVIS, so it can't be saved to memory.")
        case "FUTURE_RUNS": String(localized: "A schedule runs again in the future, so JARVIS asks before creating it.")
        // Phase C
        case "CONNECTION_EXPIRED": String(localized: "The connection it needs has expired. Reconnect it.")
        case "CONNECTION_SCOPE_MISSING": String(localized: "The connection doesn't allow this yet.")
        case "PURCHASES_DISABLED": String(localized: "Purchases are turned off (monthly purchase limit $0).")
        case "PURCHASE_LIMIT": String(localized: "It would go over your monthly purchase limit.")
        case "PURCHASE_CURRENCY": String(localized: "The price isn't in US dollars, the currency of your purchase limit.")
        case "PURCHASE": String(localized: "This spends your money. JARVIS always asks, and shows the exact total.")
        case "BINDING_COMMITMENT": String(localized: "This is binding with the site (for example, cancellation fees may apply).")
        default: nil
        }
    }
}
