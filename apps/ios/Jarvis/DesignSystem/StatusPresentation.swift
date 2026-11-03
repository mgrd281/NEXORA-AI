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
        case .unknown: String(localized: "Other service")
        }
    }

    var icon: String {
        switch self {
        case .web: "globe"
        case .smtp: "envelope"
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
        case .unknown: "questionmark.circle"
        }
    }
}
