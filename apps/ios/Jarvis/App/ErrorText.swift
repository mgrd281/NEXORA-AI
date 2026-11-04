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
        // The specific cause (ApiErrorReason) explains more than the code's general sentence.
        if let reason = error.details?["reason"]?.stringValue,
           let text = ApiErrorReasonText.describe(reason, details: error.details ?? [:]) {
            return text
        }
        return codeMessage(error.code, requestId: error.requestId, fallback: error.message)
    }

    /// The general sentence for an error code (also used for task errors without a reason).
    static func codeMessage(_ code: ErrorCode, requestId: String? = nil, fallback: String = "") -> String {
        switch code {
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
        case .payloadTooLarge:
            return String(localized: "The file is too large.")
        case .unsupportedMediaType:
            return String(localized: "JARVIS can't use this kind of file.")
        case .serviceUnavailable:
            return String(localized: "This isn't available on this server right now.")
        case .internalError:
            if let requestId {
                return String(localized: "Something went wrong on our side. Reference: \(requestId)")
            }
            return String(localized: "Something went wrong on our side. Try again later.")
        case .unknown:
            // A code from a newer server: its message is English developer text, so it is
            // shown only to English readers.
            return fallback.isEmpty || AppLocale.current != .en
                ? String(localized: "Something went wrong. Please try again.")
                : fallback
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
        case .payloadTooLarge: String(localized: "File too large")
        case .unsupportedMediaType: String(localized: "File type not supported")
        case .serviceUnavailable: String(localized: "Not available")
        default: String(localized: "Something went wrong")
        }
    }

    /// A conflict that a follow-up hits while another task of the conversation is active.
    static func busyTaskId(_ error: any Error) -> String? {
        guard let error = error as? ApiError,
              error.details?["reason"]?.stringValue == "CONVERSATION_BUSY"
                || error.details?["reason"]?.stringValue == "CONVERSATION_ACTIVE_TASK"
        else { return nil }
        return error.details?["taskId"]?.stringValue
    }
}

/// Copy for `ApiErrorReason` (sent in `error.details.reason`, parameters in `details`).
/// Keys `error.api.<REASON>`; wording mirrors the web app's catalog.
enum ApiErrorReasonText {
    static func describe(_ reason: String, details: [String: JSONValue]) -> String? {
        let p = ErrorParams(details)
        let text: String
        switch reason {
        case "FILE_TOO_LARGE":
            text = String(localized: "error.api.FILE_TOO_LARGE", defaultValue: "Files can be at most \(p.limitBytes).")
        case "UNSUPPORTED_FILE_TYPE":
            text = String(localized: "error.api.UNSUPPORTED_FILE_TYPE", defaultValue: "JARVIS reads PDF, Word (.docx), text, Markdown and CSV files.")
        case "FILE_CONTENT_MISMATCH":
            text = String(localized: "error.api.FILE_CONTENT_MISMATCH", defaultValue: "The file's content doesn't match its file type.")
        case "FILE_EMPTY":
            text = String(localized: "error.api.FILE_EMPTY", defaultValue: "The file is empty.")
        case "TOO_MANY_ATTACHMENTS":
            text = String(localized: "error.api.TOO_MANY_ATTACHMENTS", defaultValue: "You can attach up to \(p.max) files to one request.")
        case "ATTACHMENT_NOT_FOUND":
            text = String(localized: "error.api.ATTACHMENT_NOT_FOUND", defaultValue: "One of the files no longer exists. Remove it and attach it again.")
        case "ATTACHMENT_EXPIRED":
            text = String(localized: "error.api.ATTACHMENT_EXPIRED", defaultValue: "One of the files expired before it was sent. Attach it again.")
        case "ATTACHMENT_IN_OTHER_CONVERSATION":
            text = String(localized: "error.api.ATTACHMENT_IN_OTHER_CONVERSATION", defaultValue: "One of the files belongs to another conversation. Attach it again here.")
        case "STORAGE_NOT_CONFIGURED":
            text = String(localized: "error.api.STORAGE_NOT_CONFIGURED", defaultValue: "File uploads aren't set up on this server.")
        case "STORAGE_UNAVAILABLE":
            text = String(localized: "error.api.STORAGE_UNAVAILABLE", defaultValue: "File storage isn't reachable right now. Try again in a moment.")
        case "CONVERSATION_BUSY":
            text = String(localized: "error.api.CONVERSATION_BUSY", defaultValue: "JARVIS is still working on this conversation. Wait until it finishes or cancel it, then send your follow-up.")
        case "CONVERSATION_ACTIVE_TASK":
            text = String(localized: "error.api.CONVERSATION_ACTIVE_TASK", defaultValue: "A task in this conversation is still running. Wait until it finishes or cancel it, then delete the conversation.")
        case "SCHEDULE_LIMIT_REACHED":
            text = String(localized: "error.api.SCHEDULE_LIMIT_REACHED", defaultValue: "You can have up to \(p.max) schedules. Delete one to add another.")
        case "INVALID_RECURRENCE":
            text = String(localized: "error.api.INVALID_RECURRENCE", defaultValue: "This repeat rule isn't valid.")
        case "RECURRENCE_HAS_NO_OCCURRENCES":
            text = String(localized: "error.api.RECURRENCE_HAS_NO_OCCURRENCES", defaultValue: "This schedule would never run. Check the days you chose.")
        case "UNKNOWN_TIME_ZONE":
            text = String(localized: "error.api.UNKNOWN_TIME_ZONE", defaultValue: "The server doesn't know this time zone. Choose another one.")
        case "SCHEDULE_COMPLETED":
            text = String(localized: "error.api.SCHEDULE_COMPLETED", defaultValue: "This schedule has no runs left, so it can't be resumed.")
        case "SKILL_NOT_TOGGLEABLE":
            text = String(localized: "error.api.SKILL_NOT_TOGGLEABLE", defaultValue: "This skill is part of how JARVIS works and can't be turned off.")
        case "SKILL_PLANNED":
            text = String(localized: "error.api.SKILL_PLANNED", defaultValue: "This skill isn't available yet.")
        default:
            // Webhook reasons are not reachable from this app (webhooks are managed on the web).
            return nil
        }
        return p.isComplete ? text : nil
    }
}

/// Copy for a task or step error: the reason's sentence (`TaskErrorReason` + params) when this
/// build knows it, else the code's general sentence. The server's English `message` is a
/// developer fallback and is not shown.
enum TaskErrorText {
    static func describe(_ error: TaskError) -> String {
        if let reason = error.reason, let text = reasonText(reason, params: error.params ?? [:]) {
            return text
        }
        return ErrorText.codeMessage(error.code)
    }

    static func reasonText(_ reason: String, params: [String: JSONValue]) -> String? {
        let p = ErrorParams(params)
        let text: String
        switch reason {
        // web.fetch / SSRF guard
        case "INVALID_URL":
            text = String(localized: "error.reason.INVALID_URL", defaultValue: "That isn't a valid web address.")
        case "UNSUPPORTED_SCHEME":
            text = String(localized: "error.reason.UNSUPPORTED_SCHEME", defaultValue: "JARVIS only opens addresses that start with http or https.")
        case "EMBEDDED_CREDENTIALS":
            text = String(localized: "error.reason.EMBEDDED_CREDENTIALS", defaultValue: "The address contains a user name or password, so JARVIS won't open it.")
        case "MISSING_HOST":
            text = String(localized: "error.reason.MISSING_HOST", defaultValue: "The address has no host name.")
        case "PRIVATE_ADDRESS":
            text = String(localized: "error.reason.PRIVATE_ADDRESS", defaultValue: "\(p.host) is on a private or local network, so JARVIS won't open it.")
        case "FETCH_TIMEOUT":
            text = String(localized: "error.reason.FETCH_TIMEOUT", defaultValue: "\(p.host) didn't respond within \(p.seconds).")
        case "HOST_NOT_FOUND":
            text = String(localized: "error.reason.HOST_NOT_FOUND", defaultValue: "No server could be found for \(p.host).")
        case "CONNECT_FAILED":
            text = String(localized: "error.reason.CONNECT_FAILED", defaultValue: "JARVIS couldn't connect to \(p.host).")
        case "TLS_CERTIFICATE":
            text = String(localized: "error.reason.TLS_CERTIFICATE", defaultValue: "The security certificate of \(p.host) isn't valid.")
        case "FETCH_FAILED":
            text = String(localized: "error.reason.FETCH_FAILED", defaultValue: "Reading \(p.host) failed.")
        case "UNSUPPORTED_ENCODING":
            text = String(localized: "error.reason.UNSUPPORTED_ENCODING", defaultValue: "The page uses a text encoding JARVIS can't read (\(p.encoding)).")
        case "PAGE_TOO_LARGE":
            text = String(localized: "error.reason.PAGE_TOO_LARGE", defaultValue: "The page is larger than \(p.limitMb) MB.")
        case "TOO_MANY_REDIRECTS":
            text = String(localized: "error.reason.TOO_MANY_REDIRECTS", defaultValue: "The address redirected more than \(p.max) times.")
        case "HTTP_ERROR":
            text = String(localized: "error.reason.HTTP_ERROR", defaultValue: "\(p.host) answered with HTTP \(p.status).")
        case "UNSUPPORTED_CONTENT_TYPE":
            text = String(localized: "error.reason.UNSUPPORTED_CONTENT_TYPE", defaultValue: "The address returned \(p.contentType), which JARVIS can't read.")
        case "MISSING_CONTENT_TYPE":
            text = String(localized: "error.reason.MISSING_CONTENT_TYPE", defaultValue: "The server didn't say what kind of content it sent.")
        case "NO_READABLE_TEXT":
            text = String(localized: "error.reason.NO_READABLE_TEXT", defaultValue: "The page has no readable text.")
        // email.send
        case "EMAIL_NOT_CONNECTED":
            text = String(localized: "error.reason.EMAIL_NOT_CONNECTED", defaultValue: "No email account is connected.")
        case "SMTP_AUTH":
            text = String(localized: "error.reason.SMTP_AUTH", defaultValue: "The mail server didn't accept the user name or password.")
        case "SMTP_REFUSED":
            text = String(localized: "error.reason.SMTP_REFUSED", defaultValue: "The mail server refused the message (reply \(p.responseCode)).")
        case "SMTP_CONNECT":
            text = String(localized: "error.reason.SMTP_CONNECT", defaultValue: "JARVIS couldn't reach the mail server.")
        case "SMTP_UNUSABLE":
            text = String(localized: "error.reason.SMTP_UNUSABLE", defaultValue: "The mail server settings can't be used for sending.")
        case "SEND_INTERRUPTED":
            text = String(localized: "error.reason.SEND_INTERRUPTED", defaultValue: "The connection to the mail server broke off while sending.")
        case "SEND_TIMEOUT":
            text = String(localized: "error.reason.SEND_TIMEOUT", defaultValue: "The mail server stopped responding while sending.")
        // runtime
        case "STEP_INTERRUPTED":
            text = String(localized: "error.reason.STEP_INTERRUPTED", defaultValue: "“\(p.step)” was interrupted before it finished.")
        case "STEP_TIMEOUT":
            text = String(localized: "error.reason.STEP_TIMEOUT", defaultValue: "“\(p.step)” took too long and was stopped.")
        case "STEP_CRASHED":
            text = String(localized: "error.reason.STEP_CRASHED", defaultValue: "“\(p.step)” stopped because of an unexpected error.")
        case "INVALID_STEP_INPUT":
            text = String(localized: "error.reason.INVALID_STEP_INPUT", defaultValue: "“\(p.step)” got input it can't use.")
        case "UNKNOWN_TOOL":
            text = String(localized: "error.reason.UNKNOWN_TOOL", defaultValue: "The plan uses a tool this version of JARVIS doesn't have (\(p.tool)).")
        case "VERIFICATION_FAILED":
            text = String(localized: "error.reason.VERIFICATION_FAILED", defaultValue: "These steps didn't pass the check: \(p.steps).")
        // planner
        case "OFFLINE_UNSUPPORTED":
            text = String(localized: "error.reason.OFFLINE_UNSUPPORTED", defaultValue: "Without an AI model, JARVIS understands only a few kinds of requests.")
        case "MEMORY_TOO_LONG":
            text = String(localized: "error.reason.MEMORY_TOO_LONG", defaultValue: "A note can be at most \(p.max) characters long.")
        case "INVALID_PLAN":
            text = String(localized: "error.reason.INVALID_PLAN", defaultValue: "The plan JARVIS made wasn't valid.")
        case "NO_TOOLS":
            text = String(localized: "error.reason.NO_TOOLS", defaultValue: "None of the tools this needs are available.")
        case "PLANNING_FAILED":
            text = String(localized: "error.reason.PLANNING_FAILED", defaultValue: "JARVIS couldn't work out a plan for this request.")
        // policy
        case "CONNECTION_MISSING":
            text = String(localized: "error.reason.CONNECTION_MISSING", defaultValue: "“\(p.step)” needs a connection that isn't set up or isn't working.")
        case "MEMORY_DISABLED":
            text = String(localized: "error.reason.MEMORY_DISABLED", defaultValue: "Memory is turned off in your privacy settings.")
        case "RISK_CRITICAL":
            text = String(localized: "error.reason.RISK_CRITICAL", defaultValue: "The action is classified as critical risk, which JARVIS never does.")
        case "BUDGET_ZERO":
            text = String(localized: "error.reason.BUDGET_ZERO", defaultValue: "Your monthly AI budget is set to $0.")
        case "BUDGET_EXHAUSTED":
            text = String(localized: "error.reason.BUDGET_EXHAUSTED", defaultValue: "This month's AI budget is used up.")
        case "EXTERNAL_MODELS_DISABLED":
            text = String(localized: "error.reason.EXTERNAL_MODELS_DISABLED", defaultValue: "External AI models are turned off in your settings.")
        case "MODEL_UNAVAILABLE":
            text = String(localized: "error.reason.MODEL_UNAVAILABLE", defaultValue: "No AI model is available on this server.")
        case "POLICY_DENIED":
            text = String(localized: "error.reason.POLICY_DENIED", defaultValue: "The safety policy blocked “\(p.step)”.")
        // Phase B: documents, translation, follow-ups, schedules, skills
        case "ATTACHMENT_NOT_FOUND":
            text = String(localized: "error.reason.ATTACHMENT_NOT_FOUND", defaultValue: "The attached file no longer exists.")
        case "ATTACHMENT_UNREADABLE":
            text = String(localized: "error.reason.ATTACHMENT_UNREADABLE", defaultValue: "JARVIS couldn't read the attached file. It may be damaged.")
        case "ATTACHMENT_ENCRYPTED":
            text = String(localized: "error.reason.ATTACHMENT_ENCRYPTED", defaultValue: "The file is password-protected, so JARVIS can't read it.")
        case "DOCUMENT_NO_TEXT":
            text = String(localized: "error.reason.DOCUMENT_NO_TEXT", defaultValue: "The document has no text JARVIS can read, for example because it is a scan. Reading scanned pages isn't available yet.")
        case "DOCUMENT_TOO_MANY_PAGES":
            text = String(localized: "error.reason.DOCUMENT_TOO_MANY_PAGES", defaultValue: "The document has more than \(p.max) pages.")
        case "STORAGE_UNAVAILABLE":
            text = String(localized: "error.reason.STORAGE_UNAVAILABLE", defaultValue: "File storage isn't reachable right now.")
        case "UNSUPPORTED_LANGUAGE":
            text = String(localized: "error.reason.UNSUPPORTED_LANGUAGE", defaultValue: "JARVIS can't translate into \(p.language).")
        case "NOTHING_TO_RECALL":
            text = String(localized: "error.reason.NOTHING_TO_RECALL", defaultValue: "There's no earlier result in this conversation to use.")
        case "SCHEDULE_LIMIT_REACHED":
            text = String(localized: "error.reason.SCHEDULE_LIMIT_REACHED", defaultValue: "You already have \(p.max) schedules, the most you can have.")
        case "INVALID_RECURRENCE":
            text = String(localized: "error.reason.INVALID_RECURRENCE", defaultValue: "The schedule's repeat rule isn't valid.")
        case "SKILL_DISABLED":
            text = String(localized: "error.reason.SKILL_DISABLED", defaultValue: "This needs the skill “\(p.skill)”, which is turned off in Settings.")
        case "UNTRUSTED_MEMORY":
            text = String(localized: "error.reason.UNTRUSTED_MEMORY", defaultValue: "JARVIS won't save this to memory: it comes from content that tried to give instructions to AI assistants.")
        default:
            return nil
        }
        return p.isComplete ? text : nil
    }
}

/// Parameter lookup for error copy: values formatted for display and bidi-isolated; a missing
/// parameter marks the sentence incomplete so the caller falls back to a general one.
@dynamicMemberLookup
final class ErrorParams {
    private let values: [String: JSONValue]
    private(set) var isComplete = true

    init(_ values: [String: JSONValue]) {
        self.values = values
    }

    subscript(dynamicMember name: String) -> String {
        guard let value = values[name], let text = Self.display(value, name: name) else {
            isComplete = false
            return ""
        }
        return text.bidiIsolated
    }

    static func display(_ value: JSONValue, name: String) -> String? {
        switch (name, value) {
        case ("seconds", .number(let seconds)):
            return Duration.seconds(seconds).formatted(.units(allowed: [.seconds], width: .wide))
        case ("limitBytes", .number(let bytes)):
            return ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .memory)
        case ("skill", .string(let raw)):
            if let skill = SkillId(rawValue: raw), skill != .unknown { return skill.name }
            return raw
        case ("tool", .string(let raw)):
            if let tool = ToolId(rawValue: raw), tool != .unknown { return tool.label }
            return raw
        case ("language", .string(let raw)):
            return Locale.current.localizedString(forIdentifier: raw) ?? raw
        case (_, .string(let text)):
            return text
        case (_, .number(let number)):
            return ServerMessageParams.format(number)
        default:
            return nil
        }
    }
}
