import Foundation

// Mirrors Approval / ApprovalDetails / ApprovalDecisionRequest in packages/contracts/src/schemas.ts.

/// Exactly what an approval would allow, as the server will execute it.
/// Discriminated by `kind`; a kind this build does not know decodes to `.unknown`
/// and is never approvable from this app (the user cannot see what it would do).
enum ApprovalDetails: Decodable, Sendable, Equatable {
    struct Email: Decodable, Sendable, Equatable {
        /// `email.draft_reply` creates a draft in the mailbox (nothing is sent); absent = send.
        enum Mode: String, Codable, Sendable {
            case send
            case draft
            case unknown

            init(from decoder: any Decoder) throws {
                self = try LenientEnum.decode(decoder, fallback: .unknown)
            }
        }

        /// How it is sent: the SMTP connection, or the Google / Microsoft account itself.
        enum Via: String, Codable, Sendable {
            case smtp
            case google
            case microsoft
            case unknown

            init(from decoder: any Decoder) throws {
                self = try LenientEnum.decode(decoder, fallback: .unknown)
            }
        }

        /// The thread a reply belongs to; its subject is the provider's (untrusted text).
        struct ReplyContext: Decodable, Sendable, Equatable {
            let threadId: String
            let subject: String
        }

        let from: String
        let to: [String]
        let subject: String
        let body: String
        var untrusted: UntrustedSource? = nil
        // Phase C (absent on older approvals: a send through SMTP).
        var mode: Mode? = nil
        var via: Via? = nil
        var cc: [String]? = nil
        var inReplyTo: ReplyContext? = nil

        var isDraft: Bool { mode == .draft }
    }

    struct Generic: Decodable, Sendable, Equatable {
        struct Field: Decodable, Sendable, Equatable, Hashable {
            let label: String
            let value: String
        }

        let toolId: ToolId
        let fields: [Field]
        var untrusted: UntrustedSource? = nil
    }

    /// `schedule.create`: future runs, each planned and checked by the policy when it happens.
    struct ScheduleAction: Decodable, Sendable, Equatable {
        let title: String
        /// The request each run will carry out, exactly as it will be stored.
        let request: String
        let recurrence: Recurrence
        let rrule: String
        /// The first runs, as instants (shown in `recurrence.timeZone`).
        let nextOccurrences: [Date]
        var untrusted: UntrustedSource? = nil
    }

    /// `memory.save` of text that came from an earlier result: exactly what will be kept.
    struct MemoryAction: Decodable, Sendable, Equatable {
        let content: String
        let memoryKind: MemoryKind
        /// The task whose result the text came from.
        let sourceTaskId: String?
        var untrusted: UntrustedSource? = nil
    }

    /// A labelled value a site's form will receive; `personal` marks the user's own details.
    struct FormField: Decodable, Sendable, Equatable, Hashable {
        let label: String
        let value: String
        let personal: Bool
    }

    /// `calendar.create_event` / `update_event` / `cancel_event`: exactly what is written to
    /// which calendar, and who is told. Instants are shown in `timeZone`.
    struct CalendarEventAction: Decodable, Sendable, Equatable {
        enum Action: String, Codable, Sendable {
            case create
            case update
            case cancel
            case unknown

            init(from decoder: any Decoder) throws {
                self = try LenientEnum.decode(decoder, fallback: .unknown)
            }
        }

        /// The event as JARVIS read it, which an update or cancellation replaces.
        struct Previous: Decodable, Sendable, Equatable {
            let title: String
            let start: Date
            let end: Date
        }

        let action: Action
        let provider: OAuthProvider
        /// The calendar's account (its address).
        let account: String
        let eventId: String?
        let title: String
        let start: Date
        let end: Date
        /// IANA zone the event is stored and shown in.
        let timeZone: String
        let allDay: Bool
        let location: String?
        let description: String?
        /// Everyone who receives the invitation, update or cancellation.
        let attendees: [String]
        /// The provider emails the attendees.
        let notifyAttendees: Bool
        let previous: Previous?
        /// JARVIS re-checks free/busy right before writing and stops if the time is taken.
        let conflictCheck: Bool
        var untrusted: UntrustedSource? = nil
    }

    /// `booking.book` on a supported site: the slot as the site offered it live, and exactly
    /// the details the form receives.
    struct BookingAction: Decodable, Sendable, Equatable {
        let siteId: String
        let siteName: String
        let siteHost: String
        let service: String
        let start: Date
        let end: Date?
        let timeZone: String
        let fields: [FormField]
        /// As the site states it; nil when it states none.
        let price: Money?
        /// The site says it is binding (cancellation fees or payment due).
        let binding: Bool
        /// The site's cancellation terms as shown (untrusted text).
        let cancellationTerms: String?
        /// Screenshot of the live availability this booking relies on.
        let evidenceArtifactId: String?
        var untrusted: UntrustedSource? = nil
    }

    /// `shop.checkout`: the exact order and the monthly limit it is checked against.
    /// Never auto-approved; the order is submitted exactly once.
    struct PurchaseAction: Decodable, Sendable, Equatable {
        struct Merchant: Decodable, Sendable, Equatable {
            let name: String
            let host: String
        }

        struct Item: Decodable, Sendable, Equatable {
            let title: String
            let quantity: Int
            let unitPrice: Money
            let lineTotal: Money
            let productUrl: String
        }

        struct Delivery: Decodable, Sendable, Equatable {
            let method: String
            /// As the merchant states it; nil when it states none.
            let estimate: String?
            let address: String
        }

        /// The purchase limit and this month's committed purchases (USD).
        struct Limit: Decodable, Sendable, Equatable {
            let monthly: Money
            let spentThisMonth: Money
            let remainingAfter: Money
        }

        let siteId: String
        let merchant: Merchant
        let items: [Item]
        let subtotal: Money
        let shipping: Money
        let tax: Money?
        let total: Money
        let delivery: Delivery
        /// As the merchant's checkout shows it (e.g. "Visa •••• 4242").
        let paymentMethod: String
        let limit: Limit
        /// Screenshot of the cart or checkout page as checked before asking.
        let evidenceArtifactId: String?
        var untrusted: UntrustedSource? = nil
    }

    /// `browser.fill` on a supported site: exactly what the form receives.
    struct FormSubmissionAction: Decodable, Sendable, Equatable {
        let siteId: String
        let siteName: String
        let siteHost: String
        /// The recipe's form, e.g. `contact`, `reservation`.
        let form: String
        let fields: [FormField]
        let binding: Bool
        let evidenceArtifactId: String?
        var untrusted: UntrustedSource? = nil
    }

    case email(Email)
    case generic(Generic)
    case schedule(ScheduleAction)
    case memory(MemoryAction)
    case calendarEvent(CalendarEventAction)
    case booking(BookingAction)
    case purchase(PurchaseAction)
    case formSubmission(FormSubmissionAction)
    case unknown(kind: String)

    private enum CodingKeys: String, CodingKey {
        case kind
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "email":
            self = .email(try Email(from: decoder))
        case "generic":
            self = .generic(try Generic(from: decoder))
        case "schedule":
            self = .schedule(try ScheduleAction(from: decoder))
        case "memory":
            self = .memory(try MemoryAction(from: decoder))
        case "calendar_event":
            self = .calendarEvent(try CalendarEventAction(from: decoder))
        case "booking":
            self = .booking(try BookingAction(from: decoder))
        case "purchase":
            self = .purchase(try PurchaseAction(from: decoder))
        case "form_submission":
            self = .formSubmission(try FormSubmissionAction(from: decoder))
        default:
            self = .unknown(kind: kind)
        }
    }

    /// Facts about content flagged as a suspected prompt injection that this action uses.
    var untrusted: UntrustedSource? {
        switch self {
        case .email(let email): email.untrusted
        case .generic(let generic): generic.untrusted
        case .schedule(let schedule): schedule.untrusted
        case .memory(let memory): memory.untrusted
        case .calendarEvent(let event): event.untrusted
        case .booking(let booking): booking.untrusted
        case .purchase(let purchase): purchase.untrusted
        case .formSubmission(let form): form.untrusted
        case .unknown: nil
        }
    }

    /// The screenshot the server checked before asking (booking, purchase, form).
    var evidenceArtifactId: String? {
        switch self {
        case .booking(let booking): booking.evidenceArtifactId
        case .purchase(let purchase): purchase.evidenceArtifactId
        case .formSubmission(let form): form.evidenceArtifactId
        case .email, .generic, .schedule, .memory, .calendarEvent, .unknown: nil
        }
    }
}

/// `UntrustedSource`: never contains the flagged text itself.
struct UntrustedSource: Decodable, Sendable, Equatable {
    /// Host of the page the content came from, when it came from a web page.
    let host: String?
    let excludedSentences: Int?
    /// Detector signal ids, e.g. ignore_previous_instructions.
    let signals: [String]
}

struct Approval: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let taskId: String
    let taskTitle: String
    var taskTitleMessage: ServerMessage? = nil
    let stepId: String
    let toolId: ToolId
    let status: ApprovalStatus
    let riskLevel: RiskLevel
    /// Exactly what will happen, in one sentence (request language; see `summaryMessage`).
    let summary: String
    var summaryMessage: ServerMessage? = nil
    let details: ApprovalDetails
    /// Binds the decision to the exact action shown; sent back when deciding.
    let actionHash: String
    let reasons: [String]
    let expiresAt: Date
    let decidedAt: Date?
    let decisionNote: String?
    let createdAt: Date

    func isExpired(at now: Date = Date()) -> Bool {
        status == .expired || (status == .pending && expiresAt <= now)
    }

    /// Whether this app can show the action precisely enough to let the user approve it.
    var isReviewable: Bool {
        switch details {
        case .unknown: false
        case .schedule(let action): action.recurrence.isFullyKnown
        case .memory(let action): action.memoryKind != .unknown
        case .email(let email): email.mode != .unknown && email.via != .unknown
        case .generic: true
        case .calendarEvent(let event): event.action != .unknown && event.provider != .unknown
        case .booking: true
        case .purchase(let purchase): !purchase.items.isEmpty
        case .formSubmission: true
        }
    }

    var displaySummary: String { summaryMessage.rendered(or: summary) }
    var displayTaskTitle: String { taskTitleMessage.rendered(or: taskTitle) }
}

enum ApprovalDecision: String, Encodable, Sendable {
    case approve
    case reject
}

/// `POST /v1/approvals/:id/decision`.
struct ApprovalDecisionRequest: Encodable, Sendable, Equatable {
    let decision: ApprovalDecision
    let actionHash: String
    let note: String?
}
