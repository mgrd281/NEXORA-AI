import Foundation

// Localized labels, icons and tones for the Phase C enums. Values from a newer server
// (`.unknown` / `.unrecognized`) get a neutral label, never a guess.

extension OAuthProvider {
    /// The provider's product name (not translated).
    var name: String {
        switch self {
        case .google: String(localized: "Google")
        case .microsoft: String(localized: "Microsoft")
        case .unknown: String(localized: "Other service")
        }
    }

    /// What the account gives JARVIS access to.
    var summary: String {
        switch self {
        case .google: String(localized: "Gmail and Google Calendar.")
        case .microsoft: String(localized: "Outlook mail and calendar for Microsoft 365 and Outlook.com accounts.")
        case .unknown: String(localized: "A service this version of the app doesn't know yet.")
        }
    }

    var icon: String { "person.crop.circle.badge.checkmark" }

    /// The provider id as sent in task error and notification parameters.
    static func named(_ raw: String?) -> OAuthProvider? {
        guard let raw, let provider = OAuthProvider(rawValue: raw), provider != .unknown else { return nil }
        return provider
    }
}

extension ConnectionCapability {
    var label: String {
        switch self {
        case .mailRead: String(localized: "Read email")
        case .mailCompose: String(localized: "Create drafts")
        case .mailSend: String(localized: "Send email")
        case .calendarRead: String(localized: "Read the calendar")
        case .calendarWrite: String(localized: "Change the calendar")
        case .unknown: String(localized: "Other permission")
        }
    }

    /// Plain-language consequence of allowing it.
    var hint: String {
        switch self {
        case .mailRead: String(localized: "Search and read your messages, to summarize them and find what needs a reply.")
        case .mailCompose: String(localized: "Save reply drafts in your mailbox. Nothing is sent.")
        case .mailSend: String(localized: "Send email as you, each time after you approve the exact message.")
        case .calendarRead: String(localized: "See your events and when you're free.")
        case .calendarWrite: String(localized: "Add, move and cancel events and send invitations, each time after you approve the change.")
        case .unknown: String(localized: "A permission this version of the app doesn't know yet.")
        }
    }

    var icon: String {
        switch self {
        case .mailRead: "envelope.open"
        case .mailCompose: "square.and.pencil"
        case .mailSend: "paperplane"
        case .calendarRead: "calendar"
        case .calendarWrite: "calendar.badge.plus"
        case .unknown: "questionmark.circle"
        }
    }

    /// Capability ids as sent in parameters (e.g. `CONNECTION_SCOPE_MISSING { capability }`).
    static func named(_ raw: String?) -> ConnectionCapability? {
        guard let raw, let capability = ConnectionCapability(rawValue: raw), capability != .unknown else { return nil }
        return capability
    }
}

extension ConnectionStatusReason {
    /// Why the connection stopped working, and what that means until it's fixed.
    func explanation(provider: String) -> String {
        let name = provider.bidiIsolated
        switch self {
        case .grantInvalid:
            return String(localized: "\(name) no longer accepts JARVIS's access: it was revoked or ran out. Until you reconnect, JARVIS can't read or change anything there.")
        case .tokenRejected:
            return String(localized: "\(name) rejected JARVIS's access. Until you reconnect, JARVIS can't read or change anything there.")
        case .scopeMissing:
            return String(localized: "\(name) withdrew a permission. JARVIS keeps working with what is still allowed; allow the rest again if you need it.")
        case .providerError:
            return String(localized: "\(name) isn't responding reliably. JARVIS tries again with the next request; reconnecting can help if it keeps happening.")
        case .unknown:
            return String(localized: "Until you reconnect, JARVIS can't read or change anything there.")
        }
    }
}

extension BrowserSessionStatus {
    var label: String {
        switch self {
        case .queued: String(localized: "Waiting for the browser")
        case .running: String(localized: "On the site")
        case .succeeded: String(localized: "Done")
        case .failed: String(localized: "Stopped")
        case .handover: String(localized: "Your turn on the site")
        case .interrupted: String(localized: "Interrupted")
        case .unknown: String(localized: "Unknown status")
        }
    }

    var icon: String {
        switch self {
        case .queued: "clock"
        case .running: "safari"
        case .succeeded: "checkmark.circle"
        case .failed: "exclamationmark.circle"
        case .handover: "hand.point.up.left"
        case .interrupted: "bolt.horizontal.circle"
        case .unknown: "questionmark.circle"
        }
    }

    var tone: MeridianTone {
        switch self {
        case .queued, .unknown: .neutral
        case .running: .accent
        case .succeeded: .success
        case .failed: .danger
        case .handover, .interrupted: .warning
        }
    }
}

extension BrowserStopReason {
    /// Short reason a session stopped (the task error explains it in full, with the host).
    var label: String {
        switch self {
        case .captchaDetected: String(localized: "The site asks to prove you're human. JARVIS never solves these.")
        case .loginRequired: String(localized: "The site needs you to sign in. JARVIS doesn't sign in for you.")
        case .botProtection: String(localized: "The site blocks automated visits. JARVIS doesn't work around that.")
        case .siteUnsupported: String(localized: "This site isn't supported.")
        case .navigationBlocked: String(localized: "The site tried to lead somewhere that isn't allowed.")
        case .pageChanged: String(localized: "The page looks different than expected, so JARVIS stopped rather than guess.")
        case .siteError: String(localized: "The site showed an error.")
        case .budgetExceeded: String(localized: "The site needed more steps than JARVIS allows.")
        case .timeout: String(localized: "The site took too long.")
        case .crashed: String(localized: "The browser stopped unexpectedly.")
        case .cancelled: String(localized: "Cancelled.")
        case .unknown: String(localized: "It stopped for a reason this version of the app doesn't know.")
        }
    }
}

extension EvidenceArtifactKind {
    var label: String {
        switch self {
        case .screenshot: String(localized: "Screenshot")
        case .extract: String(localized: "Extracted data")
        case .ics: String(localized: "Calendar file")
        case .recording: String(localized: "Call recording")
        case .unknown: String(localized: "Evidence file")
        }
    }

    var icon: String {
        switch self {
        case .screenshot: "photo"
        case .extract: "curlybraces"
        case .ics: "calendar"
        case .recording: "waveform"
        case .unknown: "doc"
        }
    }
}

extension OrderStatus {
    var label: String {
        switch self {
        case .submitting: String(localized: "Being placed")
        case .placed: String(localized: "Placed")
        case .failed: String(localized: "Not placed")
        case .outcomeUnknown: String(localized: "Outcome unknown")
        case .unrecognized: String(localized: "Unknown status")
        }
    }

    var icon: String {
        switch self {
        case .submitting: "hourglass"
        case .placed: "checkmark.seal"
        case .failed: "xmark.circle"
        case .outcomeUnknown: "questionmark.diamond"
        case .unrecognized: "questionmark.circle"
        }
    }

    var tone: MeridianTone {
        switch self {
        case .submitting: .accent
        case .placed: .success
        case .failed: .danger
        case .outcomeUnknown: .warning
        case .unrecognized: .neutral
        }
    }

    /// What the status means for the user's money.
    var note: String? {
        switch self {
        case .submitting:
            String(localized: "JARVIS is placing this order. It counts against your monthly purchase limit.")
        case .outcomeUnknown:
            String(localized: "The order was interrupted while it was being placed. Check with the shop before ordering again; it counts against your monthly purchase limit until it's resolved.")
        case .failed:
            String(localized: "This order wasn't placed, and nothing was charged by JARVIS.")
        case .placed, .unrecognized:
            nil
        }
    }
}

extension BookingStatus {
    var label: String {
        switch self {
        case .submitting: String(localized: "Being booked")
        case .confirmed: String(localized: "Confirmed")
        case .failed: String(localized: "Not booked")
        case .outcomeUnknown: String(localized: "Outcome unknown")
        case .cancelled: String(localized: "Cancelled")
        case .unrecognized: String(localized: "Unknown status")
        }
    }

    var icon: String {
        switch self {
        case .submitting: "hourglass"
        case .confirmed: "checkmark.seal"
        case .failed: "xmark.circle"
        case .outcomeUnknown: "questionmark.diamond"
        case .cancelled: "slash.circle"
        case .unrecognized: "questionmark.circle"
        }
    }

    var tone: MeridianTone {
        switch self {
        case .submitting: .accent
        case .confirmed: .success
        case .failed: .danger
        case .outcomeUnknown: .warning
        case .cancelled, .unrecognized: .neutral
        }
    }

    var note: String? {
        switch self {
        case .outcomeUnknown:
            String(localized: "The booking was sent, but the site showed no confirmation. Check with the site before booking again.")
        case .failed:
            String(localized: "Nothing was booked.")
        case .submitting, .confirmed, .cancelled, .unrecognized:
            nil
        }
    }
}

extension EmailWatchStatus {
    var label: String {
        switch self {
        case .watching: String(localized: "Watching")
        case .replied: String(localized: "Reply received")
        case .stopped: String(localized: "Stopped")
        case .expired: String(localized: "Ended without a reply")
        case .failed: String(localized: "Couldn't check")
        case .unknown: String(localized: "Unknown status")
        }
    }

    var icon: String {
        switch self {
        case .watching: "eye"
        case .replied: "arrowshape.turn.up.left.circle"
        case .stopped: "stop.circle"
        case .expired: "timer"
        case .failed: "exclamationmark.circle"
        case .unknown: "questionmark.circle"
        }
    }

    var tone: MeridianTone {
        switch self {
        case .watching: .accent
        case .replied: .success
        case .stopped, .expired, .unknown: .neutral
        case .failed: .danger
        }
    }
}

extension ReliabilitySignalCode {
    var label: String {
        switch self {
        case .https: String(localized: "Secure connection (HTTPS)")
        case .returnPolicy: String(localized: "Return policy published")
        case .contactDetails: String(localized: "Contact details published")
        case .legalNotice: String(localized: "Legal notice published")
        case .customerRating: String(localized: "Customer rating shown")
        case .deliveryTerms: String(localized: "Delivery terms stated")
        case .unknown: String(localized: "Other signal")
        }
    }
}

extension AttendeeResponse {
    var label: String {
        switch self {
        case .accepted: String(localized: "Accepted")
        case .declined: String(localized: "Declined")
        case .tentative: String(localized: "Maybe")
        case .needsAction: String(localized: "No answer yet")
        case .unknown: String(localized: "Unknown")
        }
    }
}

extension CalendarSource {
    /// Why this calendar is missing from "Upcoming", or nil when it answered.
    var problem: String? {
        let account = (accountIdentifier ?? provider.name).bidiIsolated
        switch status {
        case .ok: return nil
        case .expired:
            return String(localized: "\(account): the connection has expired. Reconnect it to see these events.")
        case .scopeMissing:
            return String(localized: "\(account): JARVIS isn't allowed to read this calendar.")
        case .unavailable:
            return String(localized: "\(account) didn't answer in time. These events may be missing.")
        case .unknown:
            return String(localized: "\(account): these events may be missing.")
        }
    }

    /// The fix is reconnecting or allowing more in Connections.
    var needsConnectionFix: Bool { status == .expired || status == .scopeMissing }
}

extension ShoppingComparison.Site.Status {
    var label: String {
        switch self {
        case .ok: String(localized: "Read")
        case .failed: String(localized: "Couldn't read")
        case .handover: String(localized: "Needs you on the site")
        case .unknown: String(localized: "Unknown")
        }
    }

    var tone: MeridianTone {
        switch self {
        case .ok: .success
        case .failed: .danger
        case .handover: .warning
        case .unknown: .neutral
        }
    }
}

/// Names for the browser recipe operations the server sends (`BrowserSession.operation`).
enum BrowserOperationText {
    static func label(_ operation: String) -> String {
        switch operation {
        case "search": String(localized: "Search")
        case "product": String(localized: "Read a product page")
        case "cart": String(localized: "Fill the cart")
        case "checkout": String(localized: "Place the order")
        case "slots": String(localized: "Read free appointments")
        case "book": String(localized: "Book")
        case "read": String(localized: "Read the page")
        case "fill": String(localized: "Fill in the form")
        default: operation
        }
    }
}

/// Localized titles for evidence (`Evidence.code`); evidence recorded before codes existed,
/// or with a code from a newer server, keeps the server's label.
enum EvidenceText {
    static func title(_ evidence: Evidence) -> String {
        guard let code = evidence.code, let title = title(code: code) else { return evidence.label }
        return title
    }

    static func title(code: String) -> String? {
        switch code {
        case "HTTP_RESPONSE": String(localized: "Page read")
        case "CONTENT_HASH": String(localized: "Page fingerprint")
        case "SMTP_RECEIPT": String(localized: "Mail server accepted it")
        case "MODEL_OUTPUT": String(localized: "Written by an AI model")
        case "EXTRACTIVE_SUMMARY": String(localized: "Summarized without an AI model")
        case "MEMORY_RECORD": String(localized: "Saved to memory")
        case "ANSWER_TRUNCATED": String(localized: "Answer cut off")
        case "DOCUMENT_EXTRACTED": String(localized: "Document read")
        case "SCHEDULE_RECORD": String(localized: "Schedule saved")
        case "RECALLED_RESULT": String(localized: "Earlier result used")
        case "QUESTION_ASKED": String(localized: "Question asked")
        // Phase C
        case "PROVIDER_RESPONSE": String(localized: "Service answered")
        case "MAIL_SEARCH": String(localized: "Mailbox searched")
        case "MAIL_SENT": String(localized: "Email sent by the provider")
        case "MAIL_DRAFT": String(localized: "Draft saved in the mailbox")
        case "EMAIL_WATCH": String(localized: "Watching for a reply")
        case "CALENDAR_EVENT": String(localized: "Calendar updated")
        case "FREE_BUSY": String(localized: "Free and busy times read")
        case "SCREENSHOT": String(localized: "Screenshot of the page")
        case "PAGE_EXTRACT": String(localized: "Data read from the page")
        case "ICS_FILE": String(localized: "Calendar file from the site")
        case "BOOKING_CONFIRMATION": String(localized: "Booking confirmed by the site")
        case "ORDER_CONFIRMATION": String(localized: "Order confirmed by the shop")
        case "CART_SNAPSHOT": String(localized: "Cart on the shop")
        case "HANDOVER": String(localized: "Handed over to you")
        // Phase D
        case "CALL_PLACED": String(localized: "Call placed by the provider")
        case "CALL_ENDED": String(localized: "Call ended")
        case "AI_DISCLOSED": String(localized: "Said it is an AI assistant")
        case "RECORDING_CONSENT": String(localized: "Recording consent")
        case "CALL_TRANSCRIPT": String(localized: "What was said")
        case "CALL_RECORDING": String(localized: "Call recording (with consent)")
        case "CALL_TRANSFER": String(localized: "Put through to you")
        case "DO_NOT_CALL_RECORDED": String(localized: "This number won't be called again")
        default: nil
        }
    }
}
