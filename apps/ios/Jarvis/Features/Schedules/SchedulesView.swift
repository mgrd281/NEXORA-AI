import SwiftUI

/// Requests JARVIS runs on a schedule. Each run is planned and checked like a new request;
/// anything that needs approval still asks. Pausing, resuming and deleting act on the server
/// and show the state it returns.
struct SchedulesView: View {
    @Environment(AppModel.self) private var app
    @State private var model = SchedulesModel()
    @State private var editing = false
    @State private var pendingDelete: Schedule? = nil
    @State private var confirmingDelete = false

    /// Creating your own schedule is always offered below the per-account cap. The
    /// task-scheduling skill (capabilities.schedules) only governs whether JARVIS may propose
    /// schedules from requests; the web app behaves the same way.
    private var canCreate: Bool {
        model.openCount < SchedulesModel.maxPerUser
    }

    var body: some View {
        List {
            if let error = model.errorMessage {
                InlineErrorView(message: error) {
                    model.scheduleRefresh(api: app.api)
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
            Section {
                ForEach(model.items) { schedule in
                    NavigationLink(value: ScheduleRoute(id: schedule.id)) {
                        ScheduleRow(schedule: schedule, isBusy: model.busyIds.contains(schedule.id))
                    }
                    .listRowBackground(MeridianColor.surface)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) {
                            pendingDelete = schedule
                            confirmingDelete = true
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                        if schedule.status == .active {
                            Button {
                                Task { await model.pause(schedule, api: app.api) }
                            } label: {
                                Label("Pause", systemImage: "pause")
                            }
                        } else if schedule.status == .paused {
                            Button {
                                Task { await model.resume(schedule, api: app.api) }
                            } label: {
                                Label("Resume", systemImage: "play")
                            }
                        }
                    }
                }
            } footer: {
                if model.hasLoaded {
                    VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                        Text("Requests JARVIS runs for you on a schedule. Every run is planned and checked like a new request, and anything that needs your approval still asks you.")
                        Text("Schedules in use: \(model.openCount.formatted()) of \(SchedulesModel.maxPerUser.formatted())")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(MeridianColor.canvas)
        .overlay {
            if model.hasLoaded, model.items.isEmpty, model.errorMessage == nil {
                ContentUnavailableView {
                    Label("Nothing is scheduled yet", systemImage: MeridianIcon.schedules)
                } description: {
                    Text("Schedule a request to have JARVIS run it every day, week or month.")
                } actions: {
                    if canCreate {
                        Button("New schedule") { editing = true }
                            .buttonStyle(.meridianSecondary)
                            .fixedSize()
                    }
                }
            } else if !model.hasLoaded, model.isLoading {
                ProgressView()
            }
        }
        .navigationTitle(Text("Schedules"))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    editing = true
                } label: {
                    Label("New schedule", systemImage: "plus")
                }
                .disabled(!canCreate)
            }
        }
        .refreshable { await model.load(api: app.api) }
        .task { await model.load(api: app.api) }
        .task { await followEvents() }
        .onChange(of: app.live.openCount) { _, _ in
            model.scheduleRefresh(api: app.api)
        }
        .sheet(isPresented: $editing) {
            ScheduleEditorView(editing: nil) { saved in
                model.apply(saved)
            }
        }
        .confirmationDialog(
            Text("Delete this schedule?"),
            isPresented: $confirmingDelete,
            titleVisibility: .visible,
            presenting: pendingDelete
        ) { schedule in
            Button("Delete schedule", role: .destructive) {
                Task { await model.delete(schedule, api: app.api) }
            }
            Button("Keep", role: .cancel) {}
        } message: { schedule in
            Text("JARVIS stops running “\(schedule.title.bidiIsolated)”. Tasks it already created stay in your history.")
        }
    }

    private func followEvents() async {
        for await event in app.live.updates() {
            model.handle(event, api: app.api)
        }
    }
}

private struct ScheduleRow: View {
    let schedule: Schedule
    let isBusy: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            Text(verbatim: schedule.title)
                .meridianFont(.bodyStrong)
                .foregroundStyle(MeridianColor.textPrimary)
                .lineLimit(2)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: MeridianSpace.s2) { badges }
                VStack(alignment: .leading, spacing: MeridianSpace.s1) { badges }
            }
            Text(RecurrenceText.describe(schedule.recurrence))
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.textSecondary)
            if let next = schedule.nextRunAt {
                Text("Next run: \(RecurrenceText.occurrence(next, zone: schedule.recurrence.timeZone))")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
            } else if let note = schedule.stateNote {
                Text(note)
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
        }
        .padding(.vertical, MeridianSpace.s2)
        .opacity(isBusy ? 0.5 : 1)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var badges: some View {
        ToneBadge(label: schedule.status.label, systemImage: schedule.status.icon, tone: schedule.status.tone)
        if isBusy {
            ProgressView()
        }
    }
}
