import Observation
import SwiftUI

@MainActor
@Observable
final class ScheduleDetailModel {
    let scheduleId: String
    private(set) var detail: ScheduleDetail?
    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var actionError: String?
    private(set) var isPerformingAction = false
    /// The schedule no longer exists (deleted here or elsewhere).
    private(set) var isGone = false

    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    init(scheduleId: String) {
        self.scheduleId = scheduleId
    }

    func load(api: APIClient) async {
        isLoading = true
        defer { isLoading = false }
        do {
            detail = try await api.schedule(id: scheduleId)
            loadError = nil
        } catch is CancellationError {
            return
        } catch let error as ApiError where error.code == .notFound {
            isGone = true
            detail = nil
        } catch {
            loadError = ErrorText.message(for: error)
        }
    }

    func handle(_ event: StreamEvent, api: APIClient) {
        guard event.type == .scheduleChanged, event.data["scheduleId"]?.stringValue == scheduleId else { return }
        scheduleRefresh(api: api)
    }

    func scheduleRefresh(api: APIClient) {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await self?.load(api: api)
        }
    }

    func pause(api: APIClient) async {
        await perform(api: api) { _ = try await api.pauseSchedule(id: self.scheduleId) }
    }

    func resume(api: APIClient) async {
        await perform(api: api) { _ = try await api.resumeSchedule(id: self.scheduleId) }
    }

    /// Returns true once the schedule is deleted.
    func delete(api: APIClient) async -> Bool {
        guard !isPerformingAction else { return false }
        isPerformingAction = true
        actionError = nil
        defer { isPerformingAction = false }
        do {
            try await api.deleteSchedule(id: scheduleId)
            isGone = true
            return true
        } catch let error as ApiError where error.code == .notFound {
            isGone = true
            return true
        } catch is CancellationError {
            return false
        } catch {
            actionError = ErrorText.message(for: error)
            return false
        }
    }

    /// Runs an action, then reloads so upcoming runs and history match the server.
    private func perform(api: APIClient, _ action: () async throws -> Void) async {
        guard !isPerformingAction else { return }
        isPerformingAction = true
        actionError = nil
        defer { isPerformingAction = false }
        do {
            try await action()
        } catch is CancellationError {
            return
        } catch {
            actionError = ErrorText.message(for: error)
        }
        await load(api: api)
    }
}

/// One schedule: what each run asks, when it runs (in the schedule's own time zone), the
/// next occurrences and recent runs with links to the tasks they created.
struct ScheduleDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var model: ScheduleDetailModel
    @State private var editing = false
    @State private var confirmingDelete = false

    init(scheduleId: String) {
        _model = State(initialValue: ScheduleDetailModel(scheduleId: scheduleId))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MeridianSpace.s6) {
                if model.isGone {
                    NoteView(text: String(localized: "This schedule was deleted."), systemImage: "trash")
                } else if let detail = model.detail {
                    content(detail)
                } else if let error = model.loadError {
                    InlineErrorView(message: error) {
                        model.scheduleRefresh(api: app.api)
                    }
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, MeridianSpace.s10)
                }
            }
            .padding(MeridianSpace.s4)
            .frame(maxWidth: MeridianLayout.contentMaxWidth)
            .frame(maxWidth: .infinity)
        }
        .background(MeridianColor.canvas)
        .navigationTitle(Text("Schedule"))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load(api: app.api) }
        .task { await model.load(api: app.api) }
        .task { await followEvents() }
        .onChange(of: app.live.openCount) { _, _ in
            model.scheduleRefresh(api: app.api)
        }
        .sheet(isPresented: $editing) {
            if let schedule = model.detail?.schedule {
                ScheduleEditorView(editing: schedule) { _ in
                    model.scheduleRefresh(api: app.api)
                }
            }
        }
        .confirmationDialog(Text("Delete this schedule?"), isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete schedule", role: .destructive) {
                Task {
                    if await model.delete(api: app.api) { dismiss() }
                }
            }
            Button("Keep", role: .cancel) {}
        } message: {
            Text("JARVIS stops running “\((model.detail?.schedule.title ?? "").bidiIsolated)”. Tasks it already created stay in your history.")
        }
    }

    @ViewBuilder
    private func content(_ detail: ScheduleDetail) -> some View {
        let schedule = detail.schedule
        VStack(alignment: .leading, spacing: MeridianSpace.s3) {
            Text(verbatim: schedule.title)
                .meridianFont(.title1)
                .foregroundStyle(MeridianColor.textPrimary)
                .accessibilityAddTraits(.isHeader)
            ToneBadge(label: schedule.status.label, systemImage: schedule.status.icon, tone: schedule.status.tone)
            if let note = schedule.stateNote {
                Text(note)
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
            if schedule.createdBy == .agent {
                Text("JARVIS created this from a request you approved.")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textTertiary)
            }
        }

        Card {
            labeled(String(localized: "Each run asks")) {
                Text(verbatim: schedule.request)
                    .meridianFont(.body)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .textSelection(.enabled)
            }
            Divider().overlay(MeridianColor.border)
            labeled(String(localized: "Repeats")) {
                Text(RecurrenceText.describe(schedule.recurrence))
                    .meridianFont(.body)
                    .foregroundStyle(MeridianColor.textPrimary)
            }
            Divider().overlay(MeridianColor.border)
            labeled(String(localized: "Time zone")) {
                Text(RecurrenceText.zoneName(schedule.recurrence.timeZone))
                    .meridianFont(.body)
                    .foregroundStyle(MeridianColor.textPrimary)
            }
            if let last = schedule.lastRunAt {
                Divider().overlay(MeridianColor.border)
                labeled(String(localized: "Last run")) {
                    Text(RecurrenceText.occurrence(last, zone: schedule.recurrence.timeZone))
                        .meridianFont(.body)
                        .foregroundStyle(MeridianColor.textPrimary)
                }
            }
        }

        actions(schedule)

        VStack(alignment: .leading, spacing: MeridianSpace.s3) {
            SectionHeader(title: String(localized: "Coming up"), count: nil)
            if detail.upcoming.isEmpty {
                Text("No upcoming runs.")
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textSecondary)
            } else {
                Card {
                    ForEach(detail.upcoming, id: \.self) { date in
                        Label {
                            Text(RecurrenceText.occurrence(date, zone: schedule.recurrence.timeZone))
                        } icon: {
                            Image(systemName: "calendar")
                                .accessibilityHidden(true)
                        }
                        .meridianFont(.body)
                        .foregroundStyle(MeridianColor.textPrimary)
                    }
                }
            }
        }

        VStack(alignment: .leading, spacing: MeridianSpace.s3) {
            SectionHeader(title: String(localized: "Recent runs"), count: nil)
            if detail.runs.isEmpty {
                Text("No runs yet.")
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textSecondary)
            } else {
                VStack(spacing: MeridianSpace.s2) {
                    ForEach(detail.runs) { run in
                        RunRow(run: run, zone: schedule.recurrence.timeZone)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func actions(_ schedule: Schedule) -> some View {
        VStack(spacing: MeridianSpace.s3) {
            if let error = model.actionError {
                InlineErrorView(message: error)
            }
            if schedule.status == .active {
                Button {
                    Task { await model.pause(api: app.api) }
                } label: {
                    Label("Pause", systemImage: "pause")
                }
                .buttonStyle(.meridianSecondary)
                .disabled(model.isPerformingAction)
                .accessibilityHint(Text("It won't run until you resume it"))
            } else if schedule.status == .paused {
                Button {
                    Task { await model.resume(api: app.api) }
                } label: {
                    Label("Resume", systemImage: "play")
                }
                .buttonStyle(.meridianPrimary)
                .disabled(model.isPerformingAction)
                .accessibilityHint(Text("It runs again from the next scheduled time"))
            }
            if schedule.status != .completed {
                Button {
                    editing = true
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
                .buttonStyle(.meridianSecondary)
                .disabled(model.isPerformingAction)
            }
            if let conversationId = schedule.conversationId {
                NavigationLink(value: ConversationRoute(id: conversationId)) {
                    Label("Open conversation", systemImage: MeridianIcon.conversations)
                }
                .buttonStyle(.meridianSecondary)
            }
            Button {
                confirmingDelete = true
            } label: {
                Label("Delete schedule", systemImage: "trash")
            }
            .buttonStyle(.meridianDestructive)
            .disabled(model.isPerformingAction)
        }
    }

    private func labeled<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func followEvents() async {
        for await event in app.live.updates() {
            model.handle(event, api: app.api)
        }
    }
}

/// One occurrence: whether it ran, why not, and the task it created.
private struct RunRow: View {
    let run: ScheduleRun
    let zone: String

    var body: some View {
        Group {
            if let task = run.task {
                NavigationLink(value: TaskRoute(id: task.id)) {
                    rowContent
                }
                .buttonStyle(.plain)
            } else {
                rowContent
            }
        }
    }

    private var rowContent: some View {
        HStack(alignment: .top, spacing: MeridianSpace.s3) {
            VStack(alignment: .leading, spacing: MeridianSpace.s1) {
                Text(RecurrenceText.occurrence(run.occurrenceAt, zone: zone))
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textPrimary)
                HStack(spacing: MeridianSpace.s2) {
                    ToneBadge(label: run.status.label, systemImage: run.status.icon, tone: run.status.tone)
                    if let task = run.task {
                        StatusBadge(status: task.status, outcome: task.outcome)
                    }
                }
                if let reason = run.reason {
                    Text(reason.label)
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textSecondary)
                } else if run.status == .created, run.task == nil {
                    Text("The task was deleted.")
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textSecondary)
                }
            }
            Spacer(minLength: MeridianSpace.s2)
            if run.task != nil {
                Image(systemName: "chevron.forward")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(MeridianColor.textTertiary)
                    .accessibilityHidden(true)
            }
        }
        .padding(MeridianSpace.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MeridianColor.surfaceSunken, in: RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
