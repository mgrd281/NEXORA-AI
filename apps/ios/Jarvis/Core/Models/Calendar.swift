import Foundation

// Mirrors the Phase C calendar shapes in packages/contracts/src/schemas.ts. Events are read
// live from the provider (never stored by JARVIS). Titles, locations and descriptions of
// invitations are written by other people: untrusted text, shown bidi-isolated and never
// followed as instructions. Instants are UTC; each event keeps its own IANA zone.

struct CalendarAttendee: Decodable, Sendable, Equatable {
    let email: String
    let name: String?
    let response: AttendeeResponse?
    let organizer: Bool
    /// The account itself.
    let isSelf: Bool

    private enum CodingKeys: String, CodingKey {
        case email, name, response, organizer
        case isSelf = "self"
    }
}

/// `CalendarEvent.status`.
enum CalendarEventStatus: String, Codable, Sendable {
    case confirmed
    case tentative
    case cancelled
    case unknown

    init(from decoder: any Decoder) throws {
        self = try LenientEnum.decode(decoder, fallback: .unknown)
    }
}

/// An event as the provider reports it (`GET /v1/calendar/events`).
struct CalendarEvent: Decodable, Sendable, Equatable {
    /// The provider's event id.
    let id: String
    let provider: OAuthProvider
    let connectionId: String
    let title: String
    let start: Date
    let end: Date
    /// The event's own zone; nil for all-day events and when the provider gives none.
    let timeZone: String?
    let allDay: Bool
    let location: String?
    let status: CalendarEventStatus
    let organizer: String?
    let attendees: [CalendarAttendee]
    /// Opens the event at the provider.
    let webLink: String?

    /// Unique across connections (two providers may reuse an id).
    var listId: String { "\(connectionId)/\(id)" }
}

/// Home "Upcoming": an event's metadata only.
struct CalendarEventSummary: Decodable, Sendable, Equatable {
    let id: String
    let provider: OAuthProvider
    let connectionId: String
    let title: String
    let start: Date
    let end: Date
    let timeZone: String?
    let allDay: Bool
    let location: String?
    let status: CalendarEventStatus
    let webLink: String?
    let attendeeCount: Int

    var listId: String { "\(connectionId)/\(id)" }
}

/// One calendar connection that was asked, and what it answered.
struct CalendarSource: Decodable, Sendable, Equatable {
    enum Status: String, Codable, Sendable {
        case ok
        /// Reconnect.
        case expired
        /// calendar.read isn't granted.
        case scopeMissing = "scope_missing"
        /// No answer in time, or an error.
        case unavailable
        case unknown

        init(from decoder: any Decoder) throws {
            self = try LenientEnum.decode(decoder, fallback: .unknown)
        }
    }

    let connectionId: String
    let provider: OAuthProvider
    let accountIdentifier: String?
    let status: Status
}

/// The next events of every connected calendar, merged by start. `HomeSnapshot.upcoming`
/// is nil when no connection grants calendar.read: Home then shows no section at all.
struct UpcomingEvents: Decodable, Sendable, Equatable {
    let events: [CalendarEventSummary]
    let sources: [CalendarSource]
    let rangeStart: Date
    let rangeEnd: Date
    let fetchedAt: Date
}

/// `GET /v1/calendar/upcoming`.
struct UpcomingEventsResponse: Decodable, Sendable, Equatable {
    let upcoming: UpcomingEvents?
}

/// `GET /v1/calendar/events`.
struct CalendarEventList: Decodable, Sendable, Equatable {
    let items: [CalendarEvent]
    let sources: [CalendarSource]
    /// More events than the server lists at once: narrow the window.
    let truncated: Bool
}

struct BusyInterval: Decodable, Sendable, Equatable {
    let start: Date
    let end: Date
}

/// `calendar.free_busy` output: busy times per calendar and proposed free slots, computed
/// from the providers' answers only (an inaccessible calendar is never assumed free).
struct FreeBusyResult: Decodable, Sendable, Equatable {
    struct CalendarBusy: Decodable, Sendable, Equatable {
        let email: String
        /// false: the provider doesn't share this person's free/busy with the account.
        let accessible: Bool
        let busy: [BusyInterval]
    }

    let timeMin: Date
    let timeMax: Date
    let timeZone: String
    let durationMinutes: Int
    let calendars: [CalendarBusy]
    let slots: [BusyInterval]
}
