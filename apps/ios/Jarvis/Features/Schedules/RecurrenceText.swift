import Foundation

/// Phrases a recurrence from its fields in the app's language. The server sends no prose for
/// recurrences (only the fields and an informational RRULE), so this is the only wording.
enum RecurrenceText {
    static func describe(_ recurrence: Recurrence) -> String {
        let time = timeOfDay(recurrence)
        let interval = max(recurrence.interval, 1)
        let base: String
        switch recurrence.frequency {
        case .daily:
            switch interval {
            case 1:
                base = String(localized: "recurrence.daily", defaultValue: "Every day at \(time)")
            case 2:
                base = String(localized: "recurrence.daily.2", defaultValue: "Every other day at \(time)")
            default:
                let period = span(interval, unit: .day)
                base = String(localized: "recurrence.daily.n", defaultValue: "Every \(period) at \(time)")
            }
        case .weekly:
            let weekdays = recurrence.byWeekday ?? []
            let days = weekdayList(weekdays)
            switch interval {
            case 1 where isWorkweek(weekdays):
                base = String(localized: "recurrence.workdays", defaultValue: "Monday to Friday at \(time)")
            case 1:
                base = String(localized: "recurrence.weekly", defaultValue: "Every \(days) at \(time)")
            case 2:
                base = String(localized: "recurrence.weekly.2", defaultValue: "Every other week on \(days) at \(time)")
            default:
                let period = span(interval, unit: .weekOfMonth)
                base = String(localized: "recurrence.weekly.n", defaultValue: "Every \(period) on \(days) at \(time)")
            }
        case .monthly:
            let days = monthDayList(recurrence.byMonthDay ?? [])
            switch interval {
            case 1:
                base = String(localized: "recurrence.monthly", defaultValue: "Monthly on \(days) at \(time)")
            case 2:
                base = String(localized: "recurrence.monthly.2", defaultValue: "Every other month on \(days) at \(time)")
            default:
                let period = span(interval, unit: .month)
                base = String(localized: "recurrence.monthly.n", defaultValue: "Every \(period) on \(days) at \(time)")
            }
        case .unknown:
            return String(localized: "recurrence.unknown", defaultValue: "On a repeat rule this version of the app can't show")
        }
        if let until = recurrence.until {
            let date = untilDate(until)
            return String(localized: "recurrence.until", defaultValue: "\(base), until \(date)")
        }
        if let count = recurrence.count {
            let total = count.formatted()
            return String(localized: "recurrence.count", defaultValue: "\(base) · Runs in total: \(total)")
        }
        return base
    }

    /// "Every day", "Every other week", "Every 3 months" (the editor's interval control).
    static func intervalText(_ frequency: ScheduleFrequency, interval: Int) -> String {
        switch (frequency, max(interval, 1)) {
        case (.daily, 1): return String(localized: "recurrence.interval.daily", defaultValue: "Every day")
        case (.weekly, 1): return String(localized: "recurrence.interval.weekly", defaultValue: "Every week")
        case (.monthly, 1): return String(localized: "recurrence.interval.monthly", defaultValue: "Every month")
        case (.daily, 2): return String(localized: "recurrence.interval.daily.2", defaultValue: "Every other day")
        case (.weekly, 2): return String(localized: "recurrence.interval.weekly.2", defaultValue: "Every other week")
        case (.monthly, 2): return String(localized: "recurrence.interval.monthly.2", defaultValue: "Every other month")
        case (.daily, let value):
            let period = span(value, unit: .day)
            return String(localized: "recurrence.interval.n", defaultValue: "Every \(period)")
        case (.weekly, let value):
            let period = span(value, unit: .weekOfMonth)
            return String(localized: "recurrence.interval.n", defaultValue: "Every \(period)")
        case (.monthly, let value), (.unknown, let value):
            let period = span(value, unit: .month)
            return String(localized: "recurrence.interval.n", defaultValue: "Every \(period)")
        }
    }

    /// The local time of day ("9:00 AM", "09:00"), as the app's locale writes it.
    static func timeOfDay(_ recurrence: Recurrence) -> String {
        guard let clock = recurrence.hourMinute,
              let utc = TimeZone(identifier: "UTC")
        else { return recurrence.time }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        let components = DateComponents(year: 2001, month: 1, day: 1, hour: clock.hour, minute: clock.minute)
        guard let date = calendar.date(from: components) else {
            return recurrence.time
        }
        return date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: utc))
    }

    /// The zone's localized name, e.g. "Central European Time", else its identifier.
    static func zoneName(_ identifier: String) -> String {
        TimeZone(identifier: identifier)?.localizedName(for: .generic, locale: .current) ?? identifier
    }

    /// An instant in the schedule's own zone (weekday, date and time).
    static func occurrence(_ date: Date, zone identifier: String) -> String {
        var style = Date.FormatStyle.dateTime
            .weekday(.abbreviated)
            .day()
            .month(.abbreviated)
            .hour()
            .minute()
        style.timeZone = TimeZone(identifier: identifier) ?? .current
        return date.formatted(style)
    }

    static func weekdayName(_ day: Weekday) -> String {
        guard let index = day.symbolIndex else { return day.rawValue }
        let symbols = Calendar.current.weekdaySymbols
        return symbols.indices.contains(index) ? symbols[index] : day.rawValue
    }

    static func monthDayName(_ day: Int) -> String {
        if day == -1 {
            return String(localized: "recurrence.lastDay", defaultValue: "the last day")
        }
        let number = ordinal(day)
        return String(localized: "recurrence.dayOfMonth", defaultValue: "the \(number)")
    }

    // MARK: Helpers

    private static func weekdayList(_ days: [Weekday]) -> String {
        days.map(weekdayName).formatted(.list(type: .and))
    }

    private static func monthDayList(_ days: [Int]) -> String {
        // Days in calendar order, the last day of the month at the end.
        let sorted = days.filter { $0 > 0 }.sorted() + days.filter { $0 == -1 }
        return sorted.map(monthDayName).formatted(.list(type: .and))
    }

    private static func isWorkweek(_ days: [Weekday]) -> Bool {
        Set(days) == [.monday, .tuesday, .wednesday, .thursday, .friday]
    }

    /// "3 days", "3 Wochen", "٣ أشهر": the formatter handles each language's plural forms.
    private static func span(_ value: Int, unit: NSCalendar.Unit) -> String {
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .full
        formatter.allowedUnits = [unit]
        var components = DateComponents()
        switch unit {
        case .day: components.day = value
        case .weekOfMonth: components.weekOfMonth = value
        default: components.month = value
        }
        return formatter.string(from: components) ?? value.formatted()
    }

    /// "1st" / "1." for English and German; Arabic writes the plain number.
    private static func ordinal(_ value: Int) -> String {
        if AppLocale.current == .ar { return value.formatted() }
        let formatter = NumberFormatter()
        formatter.numberStyle = .ordinal
        return formatter.string(from: NSNumber(value: value)) ?? value.formatted()
    }

    /// `until` is a local date "YYYY-MM-DD"; shown as a date without a time.
    private static func untilDate(_ text: String) -> String {
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, let utc = TimeZone(identifier: "UTC") else { return text }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        guard let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12)) else {
            return text
        }
        return date.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: utc))
    }
}
