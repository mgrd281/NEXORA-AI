import Foundation

/// User-facing, localized copy for failures. Server messages are English and meant for
/// logs, so known codes get client copy; the server message is used only as a fallback.
enum ErrorText {
    static func message(for error: any Error) -> String {
        if let error = error as? ApiError { return message(for: error) }
        if let error = error as? NetworkError { return message(for: error) }
        return String(localized: "Something went wrong. Please try again.")
    }

    static func message(for error: NetworkError) -> String {
        switch error {
        case .offline:
            String(localized: "You're offline. Check your connection and try again.")
        case .timedOut:
            String(localized: "JARVIS took too long to respond. Try again.")
        case .cannotConnect:
            String(localized: "Can't reach JARVIS. Check your connection and try again.")
        case .invalidResponse:
            String(localized: "JARVIS sent a response this version of the app can't read. Update the app or try again later.")
        case .notSignedIn:
            String(localized: "Sign in to continue.")
        }
    }

    static func message(for error: ApiError) -> String {
        switch error.code {
        case .unauthenticated:
            return String(localized: "Your session has ended. Sign in again.")
        case .forbidden:
            return String(localized: "You don't have permission to do that.")
        case .notFound:
            return String(localized: "This item no longer exists.")
        case .validationFailed:
            return String(localized: "Some of the details aren't valid. Check them and try again.")
        case .conflict:
            return String(localized: "The same request is still being processed. Wait a moment and refresh.")
        case .rateLimited:
            return String(localized: "Too many requests. Try again in a moment.")
        case .idempotencyMismatch:
            return String(localized: "This request conflicts with an earlier one. Start it again.")
        case .invalidState:
            return String(localized: "This task can't do that in its current state. Refresh to see where it is.")
        case .approvalExpired:
            return String(localized: "This approval has expired, so nothing was done.")
        case .approvalMismatch:
            return String(localized: "The action changed since you reviewed it. Review it again.")
        case .connectionRequired:
            return String(localized: "This needs a connected service. Connect it in JARVIS on the web.")
        case .connectionFailed:
            return String(localized: "A connected service didn't respond. Check the connection and try again.")
        case .modelNotConfigured:
            return String(localized: "No AI model is configured, so JARVIS can't do this yet.")
        case .modelError:
            return String(localized: "The AI model returned an error. Try again.")
        case .plannerUnsupported:
            return String(localized: "JARVIS can't do this kind of request yet.")
        case .policyDenied:
            return String(localized: "Your settings don't allow this action.")
        case .budgetExceeded:
            return String(localized: "Your monthly AI budget is used up.")
        case .toolFailed, .toolTimeout:
            return String(localized: "A step didn't finish. Try again.")
        case .outcomeUnknown:
            return String(localized: "JARVIS can't confirm whether the last action took effect.")
        case .verificationFailed:
            return String(localized: "JARVIS couldn't verify the result.")
        case .fetchBlocked:
            return String(localized: "That address can't be opened by JARVIS.")
        case .internalError:
            if let requestId = error.requestId {
                return String(localized: "Something went wrong on our side. Reference: \(requestId)")
            }
            return String(localized: "Something went wrong on our side. Try again later.")
        case .unknown:
            return error.message.isEmpty
                ? String(localized: "Something went wrong. Please try again.")
                : error.message
        }
    }

    /// Short title for a task or step error code (details come from the server message).
    static func title(for code: ErrorCode) -> String {
        switch code {
        case .outcomeUnknown: String(localized: "Outcome unknown")
        case .connectionRequired, .connectionFailed: String(localized: "Connection problem")
        case .policyDenied: String(localized: "Blocked by your settings")
        case .budgetExceeded: String(localized: "Budget reached")
        case .modelNotConfigured, .modelError: String(localized: "AI model problem")
        case .approvalExpired: String(localized: "Approval expired")
        case .fetchBlocked: String(localized: "Address blocked")
        case .verificationFailed: String(localized: "Verification failed")
        case .toolTimeout: String(localized: "Step timed out")
        default: String(localized: "Something went wrong")
        }
    }
}
