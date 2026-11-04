import Foundation

// Mirrors the "Schedules (Phase B)" and "Meta" sections of packages/contracts/src/schemas.ts.

/// When a schedule runs: the RFC 5545 subset the server evaluates in `timeZone`.
///   daily   every `interval` days at `time`
///   weekly  every `interval` weeks on `byWeekday` at `time`
///   monthly every `interval` months on `byMonthDay` (1…31, −1 = last day) at `time`
struct Recurrence: Codable, Sendable, Equatable {
    var frequency: ScheduleFrequency
    var interval: Int
    var byWeekday: [Weekday]?
    var byMonthDay: [Int]?
    /// Local wall-clock time "HH:MM" (24 h).
    var time: String
    /// IANA zone the server accepts (`GET /v1/meta/time-zones`).
    var timeZone: String
    /// Last local date (YYYY-MM-DD), inclusive. Exclusive with `count`.
    var until: String?
    /// Total runs. Exclusive with `until`.
    var count: Int?

    init(
        frequency: ScheduleFrequency,
        interval: Int = 1,
        byWeekday: [Weekday]? = nil,
        byMonthDay: [Int]? = nil,
        time: String,
        timeZone: String,
        until: String? = nil,
        count: Int? = nil
    ) {
        self.frequency = frequency
        self.interval = interval
        self.byWeekday = byWeekday
        self.byMonthDay = byMonthDay
        self.time = time
        self.timeZone = timeZone
        self.until = until
        self.count = count
    }

    private enum CodingKeys: String, CodingKey {
        case frequency, interval, byWeekday, byMonthDay, time, timeZone, until, count
    }

    /// `interval` defaults to 1 when absent, as in the contract.
    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        frequency = try container.decode(ScheduleFrequency.self, forKey: .frequency)
        interval = try container.decodeIfPresent(Int.self, forKey: .interval) ?? 1
        byWeekday = try container.decodeIfPresent([Weekday].self, forKey: .byWeekday)
        byMonthDay = try container.decodeIfPresent([Int].self, forKey: .byMonthDay)
        time = try container.decode(String.self, forKey: .time)
        timeZone = try container.decode(String.self, forKey: .timeZone)
        until = try container.decodeIfPresent(String.self, forKey: .until)
        count = try container.decodeIfPresent(Int.self, forKey: .count)
    }

    /// Hour and minute of `time`, or nil when it is not "HH:MM".
    var hourMinute: (hour: Int, minute: Int)? {
        let parts = time.split(separator: ":")
        guard parts.count == 2, let hour = Int(parts[0]), let minute = Int(parts[1]),
              (0...23).contains(hour), (0...59).contains(minute)
        else { return nil }
        return (hour, minute)
    }

    /// "HH:MM" for an hour and minute.
    static func timeString(hour: Int, minute: Int) -> String {
        let h = min(max(hour, 0), 23)
        let m = min(max(minute, 0), 59)
        return (h < 10 ? "0" : "") + String(h) + ":" + (m < 10 ? "0" : "") + String(m)
    }

    /// Everything in it is a value this build knows, so it can be shown and edited exactly.
    var isFullyKnown: Bool {
        frequency != .unknown
            && !(byWeekday ?? []).contains(.unknown)
            && hourMinute != nil
    }
}

/// A request JARVIS runs on a recurrence. Every run is a normal task (source `schedule`),
/// planned and checked by the policy when it runs; a schedule never pre-approves anything.
struct Schedule: Decodable, Sendable, Equatable, Identifiable {
    enum CreatedBy: String, Codable, Sendable {
        case user
        /// Created by schedule.create from a request the user approved.
        case agent
        case unknown

        init(from decoder: any Decoder) throws {
            self = try LenientEnum.decode(decoder, fallback: .unknown)
        }
    }

    let id: String
    let title: String
    /// What each run asks JARVIS to do (user text).
    let request: String
    let language: AppLocale?
    let recurrence: Recurrence
    /// The RFC 5545 rule the server derived; informational.
    let rrule: String
    let status: ScheduleStatus
    let pausedReason: SchedulePauseReason?
    /// Nil when paused or completed.
    let nextRunAt: Date?
    let lastRunAt: Date?
    let lastTaskId: String?
    /// The conversation that collects the runs (created with the first run).
    let conversationId: String?
    let runCount: Int
    let consecutiveFailures: Int
    let createdBy: CreatedBy
    let createdAt: Date
    let updatedAt: Date
}

struct ScheduleRun: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    /// The occurrence this run is for (each occurrence runs at most once).
    let occurrenceAt: Date
    let status: ScheduleRunStatus
    let reason: ScheduleRunReason?
    /// The task created for it (nil when skipped or failed, or deleted by retention).
    let task: TaskSummary?
    let createdAt: Date
}

/// `GET /v1/schedules/:id`: the schedule with its next occurrences and recent runs.
struct ScheduleDetail: Decodable, Sendable, Equatable {
    let schedule: Schedule
    /// The next occurrences; empty when paused or completed.
    let upcoming: [Date]
    /// Newest first.
    let runs: [ScheduleRun]

    private enum CodingKeys: String, CodingKey {
        case upcoming
        case runs
    }

    init(schedule: Schedule, upcoming: [Date], runs: [ScheduleRun]) {
        self.schedule = schedule
        self.upcoming = upcoming
        self.runs = runs
    }

    /// The contract's `Schedule.extend({ upcoming, runs })`: one flat object.
    init(from decoder: any Decoder) throws {
        schedule = try Schedule(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        upcoming = try container.decode([Date].self, forKey: .upcoming)
        runs = try container.decode([ScheduleRun].self, forKey: .runs)
    }
}

/// `POST /v1/schedules`.
struct CreateScheduleRequest: Encodable, Sendable, Equatable {
    let title: String
    let request: String
    let recurrence: Recurrence
    /// Language of the request; detected by the server when nil (omitted).
    var language: AppLocale? = nil
}

/// `PATCH /v1/schedules/:id`; nil fields are omitted (unchanged).
struct UpdateScheduleRequest: Encodable, Sendable, Equatable {
    var title: String?
    var request: String?
    var recurrence: Recurrence?
}

/// `POST /v1/schedules/preview` (nothing is saved).
struct SchedulePreviewRequest: Encodable, Sendable, Equatable {
    let recurrence: Recurrence
    let count: Int
}

struct SchedulePreview: Decodable, Sendable, Equatable {
    let rrule: String
    /// The next occurrences from now (fewer when the series ends).
    let occurrences: [Date]
    /// The zone as the server stores it.
    let timeZone: String
}

/// A time zone the server accepts (`TimeZoneInfo`, `GET /v1/meta/time-zones`).
struct TimeZoneInfo: Decodable, Sendable, Equatable, Identifiable, Hashable {
    /// As the server stores it.
    let id: String
    /// Offset from UTC right now, in minutes.
    let utcOffsetMinutes: Int

    /// "UTC+01:00", "UTC−03:30", "UTC" (technical notation, not translated).
    var offsetLabel: String {
        if utcOffsetMinutes == 0 { return "UTC" }
        let sign = utcOffsetMinutes > 0 ? "+" : "\u{2212}"
        let total = abs(utcOffsetMinutes)
        let hours = total / 60
        let minutes = total % 60
        return "UTC" + sign + (hours < 10 ? "0" : "") + String(hours) + ":" + (minutes < 10 ? "0" : "") + String(minutes)
    }
}
