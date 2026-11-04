import SwiftUI

private struct SuggestionItem: Identifiable {
    let id: String
    let text: HomeCopy.SuggestionText
}

struct HomeView: View {
    @Environment(AppModel.self) private var app
    @State private var model = HomeModel()
    @State private var composer = ComposerModel()
    @State private var path = NavigationPath()
    @State private var reviewing: Approval? = nil
    @State private var showingVoice = false

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: MeridianSpace.s8) {
                    header
                    CommandComposer(
                        model: composer,
                        onSend: { send() },
                        onVoice: { showingVoice = true }
                    )
                    notices
                    content
                }
                .padding(.horizontal, MeridianSpace.s4)
                .padding(.top, MeridianSpace.s2)
                .padding(.bottom, MeridianSpace.s10)
                .frame(maxWidth: MeridianLayout.contentMaxWidth)
                .frame(maxWidth: .infinity)
            }
            .background(MeridianColor.canvas)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(Text("Home"))
            .navigationBarTitleDisplayMode(.inline)
            .jarvisDestinations()
            .refreshable { await reload() }
            .task { await reload() }
            .task { await followEvents() }
            .onChange(of: app.live.openCount) { _, _ in
                model.scheduleRefresh(api: app.api)
            }
            .onChange(of: model.snapshot?.assistant) { _, status in
                // Capability-dependent controls elsewhere (attaching files) follow the server.
                if let status { app.assistantStatus = status }
            }
            .sheet(item: $reviewing) { approval in
                ApprovalSheet(approval: approval) { _ in
                    model.scheduleRefresh(api: app.api)
                }
            }
            .sheet(isPresented: $showingVoice) {
                VoiceCaptureView(attachmentIds: composer.attachments.readyIds) { created in
                    composer.sentByVoice()
                    path.append(TaskRoute(id: created.id))
                    model.scheduleRefresh(api: app.api)
                }
            }
        }
    }

    // MARK: Sections

    private var presence: PresenceState {
        PresenceState.derive(
            from: model.presenceInputs(
                connection: app.live.state,
                isListening: app.isCapturingVoice,
                outcome: app.recentOutcome
            )
        )
    }

    private var header: some View {
        HStack(alignment: .center, spacing: MeridianSpace.s4) {
            VStack(alignment: .leading, spacing: MeridianSpace.s1) {
                Text(HomeCopy.greeting(name: app.me?.displayName ?? "", timeZone: app.me?.timeZone ?? TimeZone.current.identifier))
                    .meridianFont(.title1)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Text(presence.caption)
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textSecondary)
                    .accessibilityHidden(true)
            }
            Spacer(minLength: MeridianSpace.s2)
            PresenceView(state: presence, diameter: 56)
        }
        .padding(.top, MeridianSpace.s2)
    }

    @ViewBuilder
    private var notices: some View {
        if let snapshot = model.snapshot {
            if let notice = HomeCopy.workerNotice(snapshot.assistant) {
                NoteView(text: notice, systemImage: "exclamationmark.triangle", tone: .warning)
            }
            if let notice = HomeCopy.plannerNotice(snapshot.assistant) {
                NoteView(text: notice)
            }
        }
        if let error = model.errorMessage {
            InlineErrorView(message: error) {
                model.scheduleRefresh(api: app.api)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let snapshot = model.snapshot {
            if !snapshot.pendingApprovals.isEmpty {
                section(title: String(localized: "Needs you"), count: snapshot.pendingApprovals.count) {
                    ForEach(snapshot.pendingApprovals) { approval in
                        ApprovalCard(approval: approval) {
                            reviewing = approval
                        }
                    }
                }
            }

            if !snapshot.activeTasks.isEmpty {
                section(title: String(localized: "In progress"), count: snapshot.activeTasks.count) {
                    taskList(snapshot.activeTasks)
                }
            }

            section(title: String(localized: "Recent"), count: nil) {
                if snapshot.recentTasks.isEmpty {
                    Text("Finished tasks appear here.")
                        .meridianFont(.callout)
                        .foregroundStyle(MeridianColor.textSecondary)
                } else {
                    taskList(snapshot.recentTasks)
                }
            }

            suggestions(snapshot.suggestions)
        } else if model.isLoading {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, MeridianSpace.s8)
        }
    }

    private func section<Content: View>(title: String, count: Int?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s3) {
            SectionHeader(title: title, count: count)
            content()
        }
    }

    private func taskList(_ tasks: [TaskSummary]) -> some View {
        VStack(spacing: 0) {
            ForEach(tasks) { task in
                NavigationLink(value: TaskRoute(id: task.id)) {
                    TaskRow(task: task)
                }
                .buttonStyle(.plain)
                if task.id != tasks.last?.id {
                    Divider().overlay(MeridianColor.border)
                }
            }
        }
        .padding(.horizontal, MeridianSpace.s4)
        .background(MeridianColor.surface, in: RoundedRectangle(cornerRadius: MeridianRadius.lg, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: MeridianRadius.lg, style: .continuous)
                .strokeBorder(MeridianColor.border, lineWidth: 1)
        }
    }

    @ViewBuilder
    private func suggestions(_ suggestions: [Suggestion]) -> some View {
        let items = suggestions.compactMap { suggestion in
            HomeCopy.suggestion(suggestion).map { SuggestionItem(id: suggestion.id, text: $0) }
        }
        if !items.isEmpty {
            section(title: String(localized: "Suggestions"), count: nil) {
                ForEach(items) { item in
                    let text = item.text
                    Button {
                        if let command = text.command {
                            composer.text = command
                        } else if text.opensSettings {
                            app.selectedTab = .settings
                        }
                    } label: {
                        HStack(alignment: .top, spacing: MeridianSpace.s3) {
                            Image(systemName: text.command != nil ? "text.cursor" : "info.circle")
                                .foregroundStyle(MeridianColor.accent)
                                .accessibilityHidden(true)
                            Text(text.message)
                                .meridianFont(.callout)
                                .foregroundStyle(MeridianColor.textPrimary)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                        }
                        .padding(MeridianSpace.s3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(MeridianColor.surfaceSunken, in: RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(text.command != nil ? Text("Puts an example in the request field") : Text("Opens Settings"))
                }
            }
        }
    }

    // MARK: Actions

    private func send() {
        Task {
            if let task = await composer.submit(app: app) {
                path.append(TaskRoute(id: task.id))
                model.scheduleRefresh(api: app.api)
            }
        }
    }

    private func reload() async {
        await model.load(api: app.api)
    }

    private func followEvents() async {
        for await event in app.live.updates() {
            model.handle(event, api: app.api)
        }
    }
}
