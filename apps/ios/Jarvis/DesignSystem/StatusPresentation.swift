import Foundation

// Localized labels, icons and tones for contract enums. Tones follow
// `taskStateTone` in packages/tokens so a state looks the same on every client.

extension TaskStatus {
    var label: String {
        switch self {
        case .queued: String(localized: "Queued")
        case .planning: String(localized: "Planning")
        case .awaitingApproval: String(localized: "Needs approval")
        case .running: String(localized: "Running")
        case .verifying: String(localized: "Verifying")
        case .completed: String(localized: "Completed")
        case .failed: String(localized: "Failed")
        case .cancelled: String(localized: "Cancelled")
        case .expired: String(localized: "Expired")
        case .unknown: String(localized: "Unknown status")
        }
    }

    var tone: MeridianTone {
        switch self {
        case .queued, .cancelled, .expired, .unknown: .neutral
        case .planning, .running, .verifying: .accent
        case .awaitingApproval: .warning
        case .completed: .success
        case .failed: .danger
        }
    }
}

extension StepStatus {
    var label: String {
        switch self {
        case .pending: String(localized: "Pending")
        case .awaitingApproval: String(localized: "Needs approval")
        case .running: String(localized: "Running")
        case .succeeded: String(localized: "Succeeded")
        case .failed: String(localized: "Failed")
        case .skipped: String(localized: "Skipped")
        case .cancelled: String(localized: "Cancelled")
        case .blocked: String(localized: "Blocked")
        case .unknown: String(localized: "Unknown status")
        }
    }

    var icon: String {
        switch self {
        case .pending: "circle.dotted"
        case .awaitingApproval: "hand.raised"
        case .running: "play"
        case .succeeded: "checkmark.circle"
        case .failed: "exclamationmark.circle"
        case .skipped: "arrow.uturn.forward.circle"
        case .cancelled: "slash.circle"
        case .blocked: "nosign"
        case .unknown: "questionmark.circle"
        }
    }

    var tone: MeridianTone {
        switch self {
        case .pending, .skipped, .cancelled, .unknown: .neutral
        case .running: .accent
        case .awaitingApproval: .warning
        case .succeeded: .success
        case .failed, .blocked: .danger
        }
    }
}

extension RiskLevel {
    var label: String {
        switch self {
        case .low: String(localized: "Low risk")
        case .medium: String(localized: "Medium risk")
        case .high: String(localized: "High risk")
        case .critical: String(localized: "Critical risk")
        case .unknown: String(localized: "Unknown risk")
        }
    }

    var icon: String {
        switch self {
        case .low: "shield"
        case .medium: "exclamationmark.shield"
        case .high, .critical: "exclamationmark.triangle"
        case .unknown: "questionmark.circle"
        }
    }

    var tone: MeridianTone {
        switch self {
        case .low, .unknown: .neutral
        case .medium: .warning
        case .high, .critical: .danger
        }
    }
}

extension ApprovalStatus {
    var label: String {
        switch self {
        case .pending: String(localized: "Waiting for you")
        case .approved: String(localized: "Approved")
        case .rejected: String(localized: "Declined")
        case .expired: String(localized: "Expired")
        case .cancelled: String(localized: "Cancelled")
        case .superseded: String(localized: "Replaced by a newer request")
        case .unknown: String(localized: "Unknown status")
        }
    }
}

extension ToolId {
    var label: String {
        switch self {
        case .webFetch: String(localized: "Read a web page")
        case .textSummarize: String(localized: "Summarize text")
        case .emailSend: String(localized: "Send an email")
        case .memorySave: String(localized: "Save to memory")
        case .assistantAnswer: String(localized: "Answer a question")
        case .documentAnalyze: String(localized: "Analyze a document")
        case .textTranslate: String(localized: "Translate")
        case .scheduleCreate: String(localized: "Create a schedule")
        case .conversationRecall: String(localized: "Use an earlier result")
        case .assistantClarify: String(localized: "Ask you a question")
        case .emailSearch: String(localized: "Search email")
        case .emailReadThread: String(localized: "Read an email thread")
        case .emailDraftReply: String(localized: "Draft a reply")
        case .emailTrackReplies: String(localized: "Watch for replies")
        case .calendarList: String(localized: "Read the calendar")
        case .calendarFreeBusy: String(localized: "Find free times")
        case .calendarCreateEvent: String(localized: "Create an event")
        case .calendarUpdateEvent: String(localized: "Change an event")
        case .calendarCancelEvent: String(localized: "Cancel an event")
        case .bookingFindSlots: String(localized: "Find free appointments")
        case .bookingBook: String(localized: "Book an appointment")
        case .browserRead: String(localized: "Read a supported site")
        case .browserFill: String(localized: "Fill in a form")
        case .shopSearch: String(localized: "Search shops")
        case .shopCompare: String(localized: "Compare offers")
        case .shopPrepareCart: String(localized: "Fill a cart")
        case .shopCheckout: String(localized: "Place an order")
        case .phoneCall: String(localized: "Make a phone call")
        case .unknown: String(localized: "Other action")
        }
    }
}

extension TaskSource {
    var label: String {
        switch self {
        case .text: String(localized: "Typed request")
        case .voice: String(localized: "Voice request")
        case .schedule: String(localized: "Scheduled")
        case .api: String(localized: "API")
        case .unknown: String(localized: "Other source")
        }
    }
}

extension ConnectionStatus {
    var label: String {
        switch self {
        case .active: String(localized: "Active")
        case .error: String(localized: "Needs attention")
        case .expired: String(localized: "Expired")
        case .revoked: String(localized: "Disconnected")
        case .unknown: String(localized: "Unknown status")
        }
    }

    var tone: MeridianTone {
        switch self {
        case .active: .success
        case .error: .danger
        case .expired, .revoked, .unknown: .neutral
        }
    }
}

extension ConnectionProvider {
    var label: String {
        switch self {
        case .web: String(localized: "Web access")
        case .smtp: String(localized: "Email (SMTP)")
        case .google: String(localized: "Google")
        case .microsoft: String(localized: "Microsoft")
        case .unknown: String(localized: "Other service")
        }
    }

    var icon: String {
        switch self {
        case .web: "globe"
        case .smtp: "envelope"
        case .google, .microsoft: "person.crop.circle.badge.checkmark"
        case .unknown: MeridianIcon.connections
        }
    }
}

extension MemoryKind {
    var label: String {
        switch self {
        case .fact: String(localized: "Fact")
        case .preference: String(localized: "Preference")
        case .unknown: String(localized: "Other")
        }
    }
}

extension Platform {
    var label: String {
        switch self {
        case .web: String(localized: "Web")
        case .ios: String(localized: "iPhone")
        case .android: String(localized: "Android")
        case .macos: String(localized: "Mac")
        case .unknown: String(localized: "Other device")
        }
    }

    var icon: String {
        switch self {
        case .web: "globe"
        case .ios: "iphone"
        case .android: "candybarphone"
        case .macos: "laptopcomputer"
        case .unknown: "questionmark.circle"
        }
    }
}

extension Evidence.Kind {
    var icon: String {
        switch self {
        case .httpResponse: "globe"
        case .smtpReceipt: "envelope.badge"
        case .record: "doc.text"
        case .contentHash: "number"
        case .modelOutput: "sparkles"
        case .note: "note.text"
        case .providerResponse: "server.rack"
        case .browserCapture: "camera.viewfinder"
        case .unknown: "questionmark.circle"
        }
    }
}

// MARK: - Phase B

extension TaskOutcome {
    /// Badge for a completed task whose outcome changes what the user should do next.
    static let questionLabel = String(localized: "Needs your answer")
    static let questionIcon = "questionmark.bubble"
}

extension MissingInfo {
    /// What a clarifying question asks for, as an object phrase ("Asked for: a link").
    var label: String {
        switch self {
        case .emailContent: String(localized: "what the email should say")
        case .recipient: String(localized: "an email address")
        case .url: String(localized: "a link")
        case .document: String(localized: "a file")
        case .scheduleTime: String(localized: "a time")
        case .targetLanguage: String(localized: "a language")
        case .previousResult: String(localized: "what to send or save")
        case .details: String(localized: "more details")
        case .dateTime: String(localized: "a date and time")
        case .contactDetails: String(localized: "your contact details")
        case .product: String(localized: "which product")
        case .site: String(localized: "which site or shop")
        case .phoneNumber: String(localized: "the number to call")
        case .callGoal: String(localized: "what to say or ask on the call")
        case .unknown: String(localized: "more details")
        }
    }
}

extension AttachmentMediaType {
    var label: String {
        switch self {
        case .pdf: String(localized: "PDF")
        case .docx: String(localized: "Word")
        case .plainText: String(localized: "Text")
        case .markdown: String(localized: "Markdown")
        case .csv: String(localized: "CSV")
        case .unknown: String(localized: "File")
        }
    }

    var icon: String {
        switch self {
        case .pdf: "doc.richtext"
        case .docx: "doc.text"
        case .plainText, .markdown: "doc.plaintext"
        case .csv: "tablecells"
        case .unknown: "doc"
        }
    }
}

extension SkillId {
    var name: String {
        switch self {
        case .webResearch: String(localized: "Web research")
        case .emailManagement: String(localized: "Email")
        case .calendarManagement: String(localized: "Calendar")
        case .appointmentBooking: String(localized: "Appointment booking")
        case .phoneCalling: String(localized: "Phone calls")
        case .shoppingAssistant: String(localized: "Shopping")
        case .documentAnalysis: String(localized: "Documents")
        case .taskScheduling: String(localized: "Scheduling")
        case .personalMemory: String(localized: "Memory")
        case .deviceAutomation: String(localized: "Device automation")
        case .translation: String(localized: "Translation")
        case .workflowPlanning: String(localized: "Planning and questions")
        case .unknown: String(localized: "Other skill")
        }
    }

    var summary: String {
        switch self {
        case .webResearch: String(localized: "Reads public web pages you link to, and supported sites in an isolated browser, and summarizes them.")
        case .emailManagement: String(localized: "Reads, summarizes and drafts replies to your mail, and sends emails from your connected account, each one after you approve it.")
        case .calendarManagement: String(localized: "Reads your calendar, finds free times, and adds or changes events after you approve them.")
        case .appointmentBooking: String(localized: "Finds free appointments on supported booking sites and books one after you approve the details.")
        case .phoneCalling: String(localized: "Makes phone calls for you and says that it is an AI.")
        case .shoppingAssistant: String(localized: "Compares prices, shipping and delivery on supported shops and prepares carts. Buying needs a purchase limit and your approval of the exact total.")
        case .documentAnalysis: String(localized: "Reads files you attach (PDF, Word, text, CSV) and summarizes them.")
        case .taskScheduling: String(localized: "Runs requests for you every day, week or month.")
        case .personalMemory: String(localized: "Remembers facts and preferences you share and uses them when planning.")
        case .deviceAutomation: String(localized: "Controls apps and devices for you.")
        case .translation: String(localized: "Translates text, results and documents into other languages.")
        case .workflowPlanning: String(localized: "Plans each request, answers questions, asks when something is missing and reuses earlier results in a conversation.")
        case .unknown: String(localized: "A skill this version of the app doesn't know yet.")
        }
    }

    var icon: String {
        switch self {
        case .webResearch: "globe"
        case .emailManagement: "envelope"
        case .calendarManagement: "calendar"
        case .appointmentBooking: "calendar.badge.plus"
        case .phoneCalling: "phone"
        case .shoppingAssistant: "cart"
        case .documentAnalysis: "doc.text.magnifyingglass"
        case .taskScheduling: MeridianIcon.schedules
        case .personalMemory: MeridianIcon.memory
        case .deviceAutomation: "switch.2"
        case .translation: "character.bubble"
        case .workflowPlanning: "point.topleft.down.to.point.bottomright.curvepath"
        case .unknown: "puzzlepiece"
        }
    }
}

extension Skill {
    /// The state shown for the skill: on/off for skills the user controls, otherwise why not.
    var stateLabel: String {
        switch status {
        case .planned: return String(localized: "Planned")
        case .needsConnection: return String(localized: "Needs a connection")
        case .implemented, .unknown:
            if !canToggle, available { return String(localized: "Always on") }
            if !enabled { return String(localized: "Off") }
            return available ? String(localized: "On") : String(localized: "Not available")
        }
    }

    var stateTone: MeridianTone {
        switch status {
        case .planned, .unknown: return .neutral
        case .needsConnection: return .warning
        case .implemented: return available ? .success : .neutral
        }
    }

    var stateIcon: String {
        switch status {
        case .planned: return "clock"
        case .needsConnection: return MeridianIcon.connections
        case .implemented, .unknown: return available ? "checkmark.circle" : "minus.circle"
        }
    }

    /// Why it can't run now, in the app's language; nil when it can.
    var unavailableText: String? {
        guard let reason = unavailableReason else { return nil }
        switch reason {
        case .planned:
            return String(localized: "Not built yet.")
        case .disabledByUser:
            return String(localized: "Turned off. JARVIS won't plan or run its actions.")
        case .connectionRequired:
            let options = (connectionOptions ?? []).map(\.provider).filter { $0 != .unknown }
            if !options.isEmpty {
                var seen = Set<String>()
                let names = options.filter { seen.insert($0.rawValue).inserted }.map(\.label)
                return String(localized: "Needs one of these connections: \(names.formatted(.list(type: .or)))")
            }
            let names = requiredConnections.filter { $0 != .unknown }.map(\.label)
            if names.isEmpty { return String(localized: "Needs a connection that isn't set up.") }
            return String(localized: "Needs a connection: \(names.formatted(.list(type: .and)))")
        case .modelRequired:
            return String(localized: "Needs an AI model, and none is available right now.")
        case .memoryDisabled:
            return String(localized: "Memory is turned off.")
        case .storageNotConfigured:
            return String(localized: "File storage isn't set up on this server.")
        case .providerNotConfigured:
            return String(localized: "None of the services this skill can use is set up on this server.")
        case .browserUnavailable:
            return String(localized: "The browser agent isn't running on this server.")
        case .telephonyNotConfigured:
            return String(localized: "Phone calls aren't set up on this server.")
        case .unknown:
            return String(localized: "Not available right now.")
        }
    }
}

extension SkillModelUse {
    var label: String {
        switch self {
        case .notUsed: String(localized: "Works without an AI model.")
        case .whenAvailable: String(localized: "Uses an AI model when one is available.")
        case .needed: String(localized: "Needs an AI model.")
        case .unknown: String(localized: "Uses AI models as the server decides.")
        }
    }
}

extension ScheduleStatus {
    var label: String {
        switch self {
        case .active: String(localized: "Active")
        case .paused: String(localized: "Paused")
        case .completed: String(localized: "Finished")
        case .unknown: String(localized: "Unknown status")
        }
    }

    var tone: MeridianTone {
        switch self {
        case .active: .success
        case .paused: .warning
        case .completed, .unknown: .neutral
        }
    }

    var icon: String {
        switch self {
        case .active: "play.circle"
        case .paused: "pause.circle"
        case .completed: "checkmark.circle"
        case .unknown: "questionmark.circle"
        }
    }
}

extension Schedule {
    /// Why it is paused or finished, in the app's language.
    var stateNote: String? {
        switch status {
        case .paused:
            switch pausedReason {
            case .user: return String(localized: "Paused by you.")
            case .failures:
                return String(localized: "Paused after \(consecutiveFailures.formatted()) failed runs in a row.")
            case .budget: return String(localized: "Paused because this month's AI budget is used up.")
            case .unknown, .none: return String(localized: "Paused.")
            }
        case .completed:
            return String(localized: "All runs are done.")
        case .active, .unknown:
            return nil
        }
    }
}

extension ScheduleRunStatus {
    var label: String {
        switch self {
        case .created: String(localized: "Ran")
        case .skipped: String(localized: "Skipped")
        case .failed: String(localized: "Couldn't start")
        case .unknown: String(localized: "Unknown status")
        }
    }

    var tone: MeridianTone {
        switch self {
        case .created: .success
        case .skipped, .unknown: .neutral
        case .failed: .danger
        }
    }

    var icon: String {
        switch self {
        case .created: "checkmark.circle"
        case .skipped: "arrow.uturn.forward.circle"
        case .failed: "exclamationmark.circle"
        case .unknown: "questionmark.circle"
        }
    }
}

extension ScheduleRunReason {
    var label: String {
        switch self {
        case .budgetExhausted: String(localized: "The AI budget was used up.")
        case .schedulePaused: String(localized: "The schedule was paused.")
        case .createFailed: String(localized: "The task couldn't be created.")
        case .unknown: String(localized: "It didn't run.")
        }
    }
}

extension ScheduleFrequency {
    var label: String {
        switch self {
        case .daily: String(localized: "Daily")
        case .weekly: String(localized: "Weekly")
        case .monthly: String(localized: "Monthly")
        case .unknown: String(localized: "Other")
        }
    }
}

extension RetentionSetting {
    var label: String {
        switch self {
        case .forever: String(localized: "Until I delete them")
        case .days(let days): Self.period(days: days)
        }
    }

    /// "30 days", "1 year" in the app's language (plural forms by the formatter).
    static func period(days: Int) -> String {
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .full
        var components = DateComponents()
        if days % 365 == 0 {
            formatter.allowedUnits = [.year]
            components.year = days / 365
        } else {
            formatter.allowedUnits = [.day]
            components.day = days
        }
        return formatter.string(from: components) ?? days.formatted()
    }
}
