import Observation
import SwiftUI

/// Editable fields of a schedule. The editor covers daily, weekly (any weekdays) and monthly
/// (one day, or the last day) repeats at a local time in a zone the server accepts. A
/// schedule created on the web with a rule this editor can't show exactly (several days of
/// the month, values this build doesn't know) keeps its rule: only its name and request can
/// change here, and the screen says so.
@MainActor
@Observable
final class ScheduleEditorModel {
    let original: Schedule?
    var title = ""
    var request = ""
    var frequency: ScheduleFrequency = .weekly
    var interval = 1
    var weekdays: Set<Weekday> = [.monday]
    /// 1…31, or -1 for the last day of the month.
    var monthDay = 1
    /// Wall-clock time, kept in UTC so the picker shows exactly the stored hour and minute.
    var time: Date
    var timeZone: String
    /// The repeat rule can be changed here.
    let canEditRecurrence: Bool

    private(set) var preview: SchedulePreview?
    private(set) var previewError: String?
    private(set) var isSaving = false
    private(set) var errorMessage: String?

    @ObservationIgnored private var keyedRequest: CreateScheduleRequest?
    @ObservationIgnored private var idempotencyKey = UUID().uuidString

    static let utc = TimeZone(identifier: "UTC") ?? .gmt

    private static var utcCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        return calendar
    }

    static func clockDate(hour: Int, minute: Int) -> Date {
        let components = DateComponents(year: 2001, month: 1, day: 1, hour: hour, minute: minute)
        return utcCalendar.date(from: components) ?? Date(timeIntervalSinceReferenceDate: Double(hour * 3600 + minute * 60))
    }

    init(schedule: Schedule?, defaultTimeZone: String) {
        original = schedule
        guard let schedule else {
            time = Self.clockDate(hour: 9, minute: 0)
            timeZone = defaultTimeZone
            canEditRecurrence = true
            return
        }
        let recurrence = schedule.recurrence
        let clock = recurrence.hourMinute ?? (hour: 9, minute: 0)
        time = Self.clockDate(hour: clock.hour, minute: clock.minute)
        timeZone = recurrence.timeZone
        canEditRecurrence = recurrence.isFullyKnown
            && (recurrence.frequency != .monthly || (recurrence.byMonthDay ?? []).count == 1)
        // Every stored property is initialized; these replace the defaults.
        title = schedule.title
        request = schedule.request
        if recurrence.frequency != .unknown { frequency = recurrence.frequency }
        interval = min(max(recurrence.interval, 1), 12)
        weekdays = Set((recurrence.byWeekday ?? [.monday]).filter { $0 != .unknown })
        monthDay = recurrence.byMonthDay?.first ?? 1
    }

    var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    var trimmedRequest: String { request.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The recurrence the fields describe. `until` / `count` of an existing schedule are kept.
    var recurrence: Recurrence {
        let components = Self.utcCalendar.dateComponents([.hour, .minute], from: time)
        let clock = Recurrence.timeString(hour: components.hour ?? 9, minute: components.minute ?? 0)
        let days = Weekday.week.filter { weekdays.contains($0) }
        return Recurrence(
            frequency: frequency,
            interval: interval,
            byWeekday: frequency == .weekly ? days : nil,
            byMonthDay: frequency == .monthly ? [monthDay] : nil,
            time: clock,
            timeZone: timeZone,
            until: original?.recurrence.until,
            count: original?.recurrence.count
        )
    }

    /// Why the schedule can't be saved yet, or nil.
    var validationMessage: String? {
        if trimmedTitle.isEmpty { return String(localized: "Give the schedule a name.") }
        if trimmedTitle.contractLength > 120 { return String(localized: "The name can be at most 120 characters long.") }
        if trimmedRequest.isEmpty { return String(localized: "Write what JARVIS should do.") }
        if trimmedRequest.contractLength > 4000 { return String(localized: "The request can be at most 4,000 characters long.") }
        if canEditRecurrence, frequency == .weekly, weekdays.isEmpty { return String(localized: "Choose at least one day.") }
        return nil
    }

    var canSave: Bool { validationMessage == nil && !isSaving }

    /// The server's next occurrences for the current fields (nothing is saved).
    func refreshPreview(api: APIClient) async {
        guard canEditRecurrence, frequency != .weekly || !weekdays.isEmpty else {
            preview = nil
            return
        }
        let current = recurrence
        do {
            let result = try await api.previewSchedule(current, count: 3)
            guard current == recurrence else { return }
            preview = result
            previewError = nil
        } catch is CancellationError {
            return
        } catch {
            preview = nil
            previewError = ErrorText.message(for: error)
        }
    }

    /// Creates or updates the schedule; returns what the server stored.
    func save(api: APIClient) async -> Schedule? {
        guard canSave else { return nil }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            if let original {
                var patch = UpdateScheduleRequest()
                if trimmedTitle != original.title { patch.title = trimmedTitle }
                if trimmedRequest != original.request { patch.request = trimmedRequest }
                if canEditRecurrence, recurrence != original.recurrence { patch.recurrence = recurrence }
                if patch == UpdateScheduleRequest() { return original }
                return try await api.updateSchedule(id: original.id, patch)
            }
            let body = CreateScheduleRequest(title: trimmedTitle, request: trimmedRequest, recurrence: recurrence)
            // One key per distinct body: re-sending the same schedule after a lost response
            // replays instead of creating it twice.
            if keyedRequest != body {
                keyedRequest = body
                idempotencyKey = UUID().uuidString
            }
            return try await api.createSchedule(body, idempotencyKey: idempotencyKey)
        } catch is CancellationError {
            return nil
        } catch {
            errorMessage = ErrorText.message(for: error)
            return nil
        }
    }
}

/// Creates a schedule or edits one. Each run is a normal request: planned and checked by the
/// policy when it runs, and anything that needs approval asks then.
struct ScheduleEditorView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var model: ScheduleEditorModel? = nil
    private let editing: Schedule?
    private let onSaved: (Schedule) -> Void

    init(editing: Schedule?, onSaved: @escaping (Schedule) -> Void) {
        self.editing = editing
        self.onSaved = onSaved
    }

    var body: some View {
        NavigationStack {
            Group {
                if let model {
                    ScheduleEditorForm(model: model)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(editing == nil ? Text("New schedule") : Text("Edit schedule"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model?.isSaving == true {
                        ProgressView()
                    } else if editing == nil {
                        Button("Create") { save() }
                            .disabled(model?.canSave != true)
                    } else {
                        Button("Save") { save() }
                            .disabled(model?.canSave != true)
                    }
                }
            }
        }
        .interactiveDismissDisabled(model?.isSaving == true)
        .onAppear {
            if model == nil {
                model = ScheduleEditorModel(
                    schedule: editing,
                    defaultTimeZone: app.me?.timeZone ?? TimeZone.current.identifier
                )
            }
        }
    }

    private func save() {
        guard let model else { return }
        Task {
            if let saved = await model.save(api: app.api) {
                onSaved(saved)
                dismiss()
            }
        }
    }
}

private struct ScheduleEditorForm: View {
    @Environment(AppModel.self) private var app
    @Bindable var model: ScheduleEditorModel

    init(model: ScheduleEditorModel) {
        self.model = model
    }

    var body: some View {
        Form {
            if let error = model.errorMessage {
                Section {
                    InlineErrorView(message: error)
                        .listRowInsets(EdgeInsets())
                }
            }
            Section {
                TextField("Name", text: $model.title)
                TextField("What should JARVIS do each time?", text: $model.request, axis: .vertical)
                    .lineLimit(3...8)
            } footer: {
                Text("Written like a normal request, for example: Summarize https://example.com/news and email it to me. Each run is planned and checked when it happens; anything that needs your approval asks you then.")
            }

            if model.canEditRecurrence {
                repeatSection
                timeSection
                previewSection
            } else if let original = model.original {
                Section {
                    Text(RecurrenceText.describe(original.recurrence))
                } header: {
                    Text("Repeats")
                } footer: {
                    Text("This schedule repeats in a way this app can't edit. You can change its name and request here, and its timing in JARVIS on the web.")
                }
            }

            if let message = model.validationMessage {
                Section {
                    Text(message)
                        .foregroundStyle(MeridianColor.textSecondary)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(MeridianColor.canvas)
        .task(id: model.recurrence) {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            await model.refreshPreview(api: app.api)
        }
    }

    private var repeatSection: some View {
        Section {
            Picker(selection: $model.frequency) {
                ForEach(ScheduleFrequency.selectable, id: \.self) { frequency in
                    Text(frequency.label).tag(frequency)
                }
            } label: {
                Text("Repeats")
            }
            .pickerStyle(.segmented)

            Stepper(value: $model.interval, in: 1...12) {
                Text(RecurrenceText.intervalText(model.frequency, interval: model.interval))
            }

            if model.frequency == .weekly {
                WeekdayChips(selection: $model.weekdays)
            }

            if model.frequency == .monthly {
                Picker(selection: $model.monthDay) {
                    ForEach(1...31, id: \.self) { day in
                        Text(verbatim: day.formatted()).tag(day)
                    }
                    Text("Last day of the month").tag(-1)
                } label: {
                    Text("Day of the month")
                }
            }
        } header: {
            Text("Repeats")
        } footer: {
            if model.frequency == .monthly {
                Text("A month without this day is skipped.")
            }
        }
    }

    private var timeSection: some View {
        Section {
            DatePicker(selection: $model.time, displayedComponents: .hourAndMinute) {
                Text("Time")
            }
            .environment(\.timeZone, ScheduleEditorModel.utc)

            NavigationLink {
                TimeZonePickerView(selection: $model.timeZone)
            } label: {
                LabeledContent {
                    Text(RecurrenceText.zoneName(model.timeZone))
                } label: {
                    Text("Time zone")
                }
            }
        } footer: {
            Text("The schedule keeps this local time, also when the clocks change for daylight saving.")
        }
    }

    private var previewSection: some View {
        Section {
            if let preview = model.preview {
                if preview.occurrences.isEmpty {
                    Text("This schedule would never run.")
                        .foregroundStyle(MeridianColor.danger)
                } else {
                    ForEach(preview.occurrences, id: \.self) { date in
                        Text(RecurrenceText.occurrence(date, zone: preview.timeZone))
                    }
                }
            } else if let error = model.previewError {
                Text(error)
                    .foregroundStyle(MeridianColor.danger)
            } else {
                Text("Working out the next runs…")
                    .foregroundStyle(MeridianColor.textSecondary)
            }
        } header: {
            Text("Next runs")
        } footer: {
            Text(RecurrenceText.describe(model.recurrence))
        }
    }
}

/// Weekday choices as toggle buttons (selected state announced to VoiceOver).
private struct WeekdayChips: View {
    @Binding var selection: Set<Weekday>

    init(selection: Binding<Set<Weekday>>) {
        _selection = selection
    }

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            Text("On these days")
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: MeridianSpace.s1) { chips(short: true) }
                VStack(alignment: .leading, spacing: MeridianSpace.s1) { chips(short: false) }
            }
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func chips(short: Bool) -> some View {
        ForEach(Weekday.week, id: \.self) { day in
            let selected = selection.contains(day)
            Button {
                if selected { selection.remove(day) } else { selection.insert(day) }
            } label: {
                Text(verbatim: short ? Self.shortName(day) : RecurrenceText.weekdayName(day))
                    .meridianFont(.label)
                    .padding(.horizontal, MeridianSpace.s2)
                    .frame(minWidth: MeridianLayout.minTouchTarget, minHeight: MeridianLayout.minTouchTarget)
                    .foregroundStyle(selected ? MeridianColor.onInk : MeridianColor.textPrimary)
                    .background(selected ? MeridianColor.ink : MeridianColor.surface, in: Capsule())
                    .overlay {
                        Capsule().strokeBorder(selected ? Color.clear : MeridianColor.borderControl, lineWidth: 1)
                    }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(verbatim: RecurrenceText.weekdayName(day)))
            .accessibilityAddTraits(selected ? [.isSelected] : [])
        }
    }

    private static func shortName(_ day: Weekday) -> String {
        guard let index = day.symbolIndex else { return day.rawValue }
        let symbols = Calendar.current.shortWeekdaySymbols
        return symbols.indices.contains(index) ? symbols[index] : day.rawValue
    }
}
