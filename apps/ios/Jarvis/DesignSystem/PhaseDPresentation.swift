import Foundation

// Labels, icons and tones for the Phase D phone-call enums (docs/architecture/phase-d.md).
// Status is never colour alone: every state has an icon and a label.

/// "HH:MM" wall-clock times and "YYYY-MM-DD" dates of a call (in the callee's zone), formatted
/// in the app's locale without any time-zone arithmetic.
enum LocalTimeText {
    private static let utc = TimeZone(identifier: "UTC") ?? .gmt

    /// "08:00" → "8:00 AM" (en-US) / "08:00" (de) — nil unless it is a valid HH:MM.
    static func format(_ value: String) -> String? {
        let parts = value.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].count == 2, parts[1].count == 2,
              let hour = Int(parts[0]), let minute = Int(parts[1]),
              (0...23).contains(hour), (0...59).contains(minute)
        else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        guard let date = calendar.date(from: DateComponents(year: 2000, month: 1, day: 1, hour: hour, minute: minute))
        else { return nil }
        return date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: utc))
    }

    /// "2026-11-10" → "Tue, Nov 10, 2026" in the app's locale — nil unless a valid date.
    static func formatDate(_ value: String) -> String? {
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2])
        else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        let components = DateComponents(year: year, month: month, day: day, hour: 12)
        guard components.isValidDate(in: calendar), let date = calendar.date(from: components) else { return nil }
        var style = Date.FormatStyle(date: .complete, time: .omitted, timeZone: utc)
        style.calendar = calendar
        return date.formatted(style)
    }

    /// "08:00–20:00" formatted, or the raw values when they aren't HH:MM.
    static func window(start: String, end: String) -> String {
        "\(format(start) ?? start)–\(format(end) ?? end)"
    }
}

extension CallStatus {
    var label: String {
        switch self {
        case .queued: String(localized: "Getting ready to call")
        case .dialing: String(localized: "Dialing")
        case .ringing: String(localized: "Ringing")
        case .inProgress: String(localized: "On the call")
        case .ended: String(localized: "Call ended")
        case .outcomeUnknown: String(localized: "Not confirmed by the provider")
        case .unrecognized: String(localized: "Unknown status")
        }
    }

    var icon: String {
        switch self {
        case .queued: "clock"
        case .dialing: "phone.arrow.up.right"
        case .ringing: "bell"
        case .inProgress: "phone.connection"
        case .ended: "phone.down"
        case .outcomeUnknown: "questionmark.diamond"
        case .unrecognized: "questionmark.circle"
        }
    }

    var tone: MeridianTone {
        switch self {
        case .queued, .unrecognized: .neutral
        case .dialing, .ringing, .inProgress: .accent
        case .ended: .neutral
        case .outcomeUnknown: .warning
        }
    }
}

extension CallResult {
    var label: String {
        switch self {
        case .completed: String(localized: "Goal reached")
        case .answered: String(localized: "Answered, goal not reached")
        case .busy: String(localized: "Busy")
        case .noAnswer: String(localized: "No answer")
        case .failed: String(localized: "Couldn't connect")
        case .voicemail: String(localized: "Voicemail")
        case .hungUp: String(localized: "Hung up")
        case .declined: String(localized: "Didn't want to talk to an AI")
        case .canceled: String(localized: "Cancelled before it connected")
        case .unknown: String(localized: "Ended")
        }
    }

    var icon: String {
        switch self {
        case .completed: "checkmark.circle"
        case .answered: "phone.badge.checkmark"
        case .busy: "phone.badge.waveform"
        case .noAnswer: "phone.down.circle"
        case .failed: "exclamationmark.circle"
        case .voicemail: "recordingtape"
        case .hungUp: "phone.down"
        case .declined: "hand.raised"
        case .canceled: "slash.circle"
        case .unknown: "phone.down"
        }
    }

    var tone: MeridianTone {
        switch self {
        case .completed: .success
        case .answered: .accent
        case .busy, .noAnswer, .voicemail, .hungUp: .warning
        case .failed, .declined: .danger
        case .canceled, .unknown: .neutral
        }
    }
}

extension CallPurpose {
    var label: String {
        switch self {
        case .message: String(localized: "Deliver a message and note the reply")
        case .availability: String(localized: "Ask which times are free")
        case .questions: String(localized: "Ask your questions")
        case .appointment: String(localized: "Book an appointment")
        case .unknown: String(localized: "A purpose this version of the app doesn't know")
        }
    }
}

extension RecordingMode {
    /// Stated plainly in the approval: what happens to the audio.
    var label: String {
        switch self {
        case .off: String(localized: "Not recorded. Only what was said is kept, as text.")
        case .ifConsented: String(localized: "Recorded only if the other person agrees when asked at the start. Otherwise not recorded.")
        case .required: String(localized: "JARVIS asks to record at the start. If the other person says no, it ends the call politely.")
        case .unknown: String(localized: "A recording setting this version of the app doesn't know")
        }
    }
}

extension RecordingConsent {
    var label: String {
        switch self {
        case .notAsked: String(localized: "Not asked (recording off)")
        case .accepted: String(localized: "The other person agreed to the recording")
        case .declined: String(localized: "The other person declined the recording")
        case .unknown: String(localized: "Unknown")
        }
    }
}

extension VoicemailAction {
    var label: String {
        switch self {
        case .hangUp: String(localized: "If a voicemail answers, JARVIS hangs up without leaving a message.")
        case .leaveMessage: String(localized: "If a voicemail answers, JARVIS leaves the voicemail message shown above.")
        case .unknown: String(localized: "A voicemail setting this version of the app doesn't know")
        }
    }
}

extension AnsweredBy {
    var label: String {
        switch self {
        case .human: String(localized: "A person answered")
        case .machine: String(localized: "A machine answered")
        case .fax: String(localized: "A fax machine answered")
        case .undetermined: String(localized: "The provider couldn't tell who answered")
        case .unrecognized: String(localized: "Unknown")
        }
    }
}

extension CallSpeaker {
    var label: String {
        switch self {
        case .agent: String(localized: "JARVIS")
        case .callee: String(localized: "The other person")
        case .system: String(localized: "Announcement")
        case .unknown: String(localized: "Unknown speaker")
        }
    }
}

extension CallTurnKind {
    var label: String {
        switch self {
        case .disclosure: String(localized: "Introduction as an AI assistant")
        case .consentRequest: String(localized: "Recording question")
        case .consentReply: String(localized: "Answer about the recording")
        case .question: String(localized: "Question")
        case .answer: String(localized: "Answer")
        case .statement: String(localized: "Statement")
        case .clarification: String(localized: "Clarification")
        case .refusal: String(localized: "Refusal")
        case .transfer: String(localized: "Putting through")
        case .voicemail: String(localized: "Voicemail message")
        case .goodbye: String(localized: "Goodbye")
        case .unknown: String(localized: "Turn")
        }
    }
}

extension CallNoteCode {
    var label: String {
        switch self {
        case .optedOut: String(localized: "They asked not to be called again. The number is on your do-not-call list now.")
        case .recordingConsentAccepted: String(localized: "They agreed to the recording.")
        case .recordingConsentDeclined: String(localized: "They declined the recording.")
        case .transferRequested: String(localized: "They asked to speak to a person.")
        case .transferConnected: String(localized: "They were put through to you.")
        case .transferFailed: String(localized: "Putting them through to you didn't work.")
        case .transferUnavailable: String(localized: "JARVIS couldn't put them through (not allowed or no verified number) and said you'd call back.")
        case .outsidePurposeRefused: String(localized: "JARVIS refused something outside what you approved.")
        case .injectionFlagged: String(localized: "They said something that looked like instructions to an AI. JARVIS ignored it.")
        case .lowConfidence: String(localized: "JARVIS wasn't sure it understood and asked again.")
        case .durationLimit: String(localized: "The call reached its maximum length.")
        case .voicemailMessageLeft: String(localized: "A voicemail answered and the approved message was left.")
        case .unknown: String(localized: "A note this version of the app doesn't know.")
        }
    }

    var icon: String {
        switch self {
        case .optedOut: "phone.down.waves.left.and.right"
        case .recordingConsentAccepted, .recordingConsentDeclined: "record.circle"
        case .transferRequested, .transferConnected, .transferFailed, .transferUnavailable: "arrow.triangle.branch"
        case .outsidePurposeRefused: "hand.raised"
        case .injectionFlagged: "exclamationmark.triangle"
        case .lowConfidence: "ear"
        case .durationLimit: "timer"
        case .voicemailMessageLeft: "recordingtape"
        case .unknown: "info.circle"
        }
    }
}

extension CallSession.Transfer.Status {
    var label: String? {
        switch self {
        case .notRequested: nil
        case .requested: String(localized: "Putting them through to you…")
        case .connected: String(localized: "Put through to you")
        case .failed: String(localized: "Putting them through didn't work")
        case .unavailable: String(localized: "Couldn't put them through")
        case .unknown: String(localized: "Transfer status unknown")
        }
    }
}

extension DoNotCallSource {
    var label: String {
        switch self {
        case .calleeRequest: String(localized: "They asked during a call")
        case .user: String(localized: "You added it")
        case .unknown: String(localized: "Added")
        }
    }
}

extension PhoneVerificationStatus {
    var label: String {
        switch self {
        case .calling: String(localized: "Calling your number…")
        case .pending: String(localized: "Waiting for the code")
        case .verified: String(localized: "Verified")
        case .expired: String(localized: "Expired")
        case .failed: String(localized: "The call didn't go through")
        case .unknown: String(localized: "Unknown status")
        }
    }
}

extension ApprovalDetails.PhoneCallAction.Dialog {
    var label: String {
        switch self {
        case .scripted: String(localized: "Only the lines below, plus fixed answers such as who is calling. JARVIS doesn't improvise.")
        case .model: String(localized: "The lines below; JARVIS may also answer questions within this purpose and the details listed. It never agrees to anything else or shares anything else.")
        case .unknown: String(localized: "A dialog mode this version of the app doesn't know")
        }
    }
}

extension AppLocale {
    /// The language's name in the app's language ("German"), for the language of a call.
    var languageName: String {
        switch self {
        case .unknown: String(localized: "Another language")
        default: Locale.current.localizedString(forLanguageCode: rawValue) ?? rawValue
        }
    }

    /// The writing direction of text in this language (call scripts are shown in their own).
    var isRightToLeft: Bool { self == .ar }
}

/// A phone number for display: always laid out left to right, also in Arabic.
enum PhoneText {
    /// A country code ("DE") as its name in the app's language.
    static func country(_ code: String?) -> String? {
        guard let code, !code.isEmpty else { return nil }
        return Locale.current.localizedString(forRegionCode: code) ?? code
    }

    /// Seconds as "5 min" / "45 s".
    static func duration(_ seconds: Int) -> String {
        let units: Set<Duration.UnitsFormatStyle.Unit> = seconds >= 60 ? [.minutes, .seconds] : [.seconds]
        return Duration.seconds(seconds).formatted(.units(allowed: units, width: .abbreviated))
    }
}

extension CallSession {
    /// Why this attempt didn't reach its goal, in the app's language (nil when it did).
    var failureText: String? {
        guard let reason = failureReason else { return nil }
        let params: [String: JSONValue] = [
            "seconds": .number(Double(maxDurationSeconds)),
            "number": .string(toDisplay),
        ]
        return TaskErrorText.reasonText(reason, params: params) ?? String(localized: "The call didn't reach its goal.")
    }
}
