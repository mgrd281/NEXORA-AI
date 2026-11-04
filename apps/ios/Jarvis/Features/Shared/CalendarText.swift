import Foundation

/// Dates and times of events, slots and bookings: always formatted in the event's own time
/// zone (computed with the zone, never by adding hours to UTC), in the app's locale.
enum CalendarText {
    static func zone(_ identifier: String?) -> TimeZone {
        identifier.flatMap(TimeZone.init(identifier:)) ?? .current
    }

    /// "Tue, 5 Nov, 10:00 – 11:00" (or "5 Nov · all day") in the event's zone. When the
    /// event's zone isn't `viewerZone`, its short name follows, so a time is never misread.
    static func when(
        start: Date,
        end: Date?,
        timeZone identifier: String?,
        allDay: Bool,
        viewerZone: String? = nil
    ) -> String {
        let tz = zone(identifier ?? viewerZone)
        if allDay {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = tz
            // All-day ends are exclusive (the next midnight).
            let last = end.map { max(start, $0.addingTimeInterval(-1)) } ?? start
            let days: String
            if calendar.isDate(start, inSameDayAs: last) {
                days = start.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: tz))
            } else {
                days = (start..<last).formatted(Date.IntervalFormatStyle(date: .abbreviated, timeZone: tz))
            }
            return String(localized: "\(days) · all day")
        }
        let text: String
        if let end, end > start {
            text = (start..<end).formatted(Date.IntervalFormatStyle(date: .abbreviated, time: .shortened, timeZone: tz))
        } else {
            text = start.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, timeZone: tz))
        }
        guard let identifier, let viewerZone, identifier != viewerZone,
              let own = TimeZone(identifier: identifier),
              own.secondsFromGMT(for: start) != zone(viewerZone).secondsFromGMT(for: start)
        else { return text }
        return "\(text) (\(shortZoneName(own, at: start)))"
    }

    /// Only the time of day ("10:00 – 11:00"), for rows under a day heading.
    static func timeRange(start: Date, end: Date?, timeZone identifier: String?) -> String {
        let tz = zone(identifier)
        if let end, end > start {
            return (start..<end).formatted(Date.IntervalFormatStyle(time: .shortened, timeZone: tz))
        }
        return start.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: tz))
    }

    /// "CET", "GMT+1" and the like.
    static func shortZoneName(_ zone: TimeZone, at date: Date) -> String {
        zone.localizedName(for: zone.isDaylightSavingTime(for: date) ? .shortDaylightSaving : .shortStandard, locale: .current)
            ?? zone.abbreviation(for: date)
            ?? zone.identifier
    }

    /// "Today", "Tomorrow", else "Thursday, 7 November" — in `zone`.
    static func dayTitle(_ date: Date, zone: TimeZone, now: Date = Date()) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        if calendar.isDate(date, inSameDayAs: now) { return String(localized: "Today") }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) {
            return String(localized: "Tomorrow")
        }
        var style = Date.FormatStyle.dateTime.weekday(.wide).day().month(.wide)
        style.timeZone = zone
        return date.formatted(style)
    }

    /// The start of the day containing `date` in `zone` (for grouping).
    static func dayStart(_ date: Date, zone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.startOfDay(for: date)
    }
}
