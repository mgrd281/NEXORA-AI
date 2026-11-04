import SwiftUI

/// Conversation history. Each conversation keeps a request together with its follow-ups and
/// JARVIS's answers; opening one shows the thread, where a follow-up can be sent.
struct ConversationListView: View {
    @Environment(AppModel.self) private var app
    @State private var model = ConversationListModel()
    @State private var path = NavigationPath()
    @State private var pendingDelete: ConversationSummary? = nil
    @State private var confirmingDelete = false

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let error = model.errorMessage {
                    InlineErrorView(message: error) {
                        model.scheduleRefresh(api: app.api)
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
                Section {
                    ForEach(model.items) { conversation in
                        NavigationLink(value: ConversationRoute(id: conversation.id)) {
                            ConversationRow(
                                conversation: conversation,
                                isDeleting: model.deletingIds.contains(conversation.id)
                            )
                        }
                        .listRowBackground(MeridianColor.surface)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                requestDelete(conversation)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                        .contextMenu {
                            Button(role: .destructive) {
                                requestDelete(conversation)
                            } label: {
                                Label("Delete conversation", systemImage: "trash")
                            }
                        }
                        .onAppear {
                            if conversation.id == model.items.last?.id {
                                Task { await model.loadMore(api: app.api) }
                            }
                        }
                    }
                    if model.isLoadingMore {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .listRowBackground(Color.clear)
                    }
                } footer: {
                    if model.hasLoaded, !model.items.isEmpty {
                        Text("Each conversation keeps a request together with its follow-ups and answers.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(MeridianColor.canvas)
            .overlay {
                if model.hasLoaded, model.items.isEmpty, model.errorMessage == nil {
                    if model.trimmedSearch == nil {
                        ContentUnavailableView {
                            Label("No conversations yet", systemImage: MeridianIcon.conversations)
                        } description: {
                            Text("Every request you send to JARVIS starts one.")
                        }
                    } else {
                        ContentUnavailableView.search(text: model.search)
                    }
                } else if !model.hasLoaded, model.isLoading {
                    ProgressView()
                }
            }
            .navigationTitle(Text("Conversations"))
            .searchable(text: $model.search, prompt: Text("Search titles and requests"))
            .jarvisDestinations()
            .refreshable { await model.reload(api: app.api) }
            .task(id: model.search) { await searchChanged() }
            .task { await followEvents() }
            .onChange(of: app.live.openCount) { _, _ in
                model.scheduleRefresh(api: app.api)
            }
            .confirmationDialog(
                Text("Delete this conversation?"),
                isPresented: $confirmingDelete,
                titleVisibility: .visible,
                presenting: pendingDelete
            ) { conversation in
                Button("Delete conversation", role: .destructive) {
                    Task { await model.delete(conversation, api: app.api) }
                }
                Button("Keep", role: .cancel) {}
            } message: { conversation in
                if conversation.scheduleId != nil {
                    Text("Its requests, results and attached files are deleted. This can't be undone. The schedule that runs it stays; its next run starts a new conversation.")
                } else {
                    Text("Its requests, results and attached files are deleted. This can't be undone.")
                }
            }
        }
    }

    private func requestDelete(_ conversation: ConversationSummary) {
        pendingDelete = conversation
        confirmingDelete = true
    }

    /// Debounces typing in the search field; `.task(id:)` cancels the previous wait.
    private func searchChanged() async {
        if model.hasLoaded {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
        }
        await model.reload(api: app.api)
    }

    private func followEvents() async {
        for await event in app.live.updates() {
            model.handle(event, api: app.api)
        }
    }
}

private struct ConversationRow: View {
    let conversation: ConversationSummary
    let isDeleting: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            Text(conversation.displayTitle)
                .meridianFont(.bodyStrong)
                .foregroundStyle(MeridianColor.textPrimary)
                .multilineTextAlignment(.leading)
                .lineLimit(2)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: MeridianSpace.s2) { badges }
                VStack(alignment: .leading, spacing: MeridianSpace.s1) { badges }
            }
            if let line = lastLine {
                Text(line)
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textSecondary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, MeridianSpace.s2)
        .frame(minHeight: MeridianLayout.minTouchTarget)
        .opacity(isDeleting ? 0.4 : 1)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var badges: some View {
        if conversation.hasActiveTask {
            ToneBadge(label: String(localized: "In progress"), systemImage: MeridianIcon.status(.running), tone: .accent)
        } else if let last = conversation.lastTask {
            StatusBadge(status: last.status, outcome: last.outcome)
        }
        if conversation.scheduleId != nil {
            ToneBadge(label: String(localized: "Scheduled"), systemImage: MeridianIcon.schedules, tone: .neutral)
        }
        Text("Requests: \(conversation.taskCount.formatted())")
            .meridianFont(.caption)
            .foregroundStyle(MeridianColor.textSecondary)
        Text(MeridianFormat.relative(conversation.updatedAt))
            .meridianFont(.caption)
            .foregroundStyle(MeridianColor.textTertiary)
    }

    /// The newest task's outcome: its question, result or error, in the app's language.
    private var lastLine: String? {
        guard let task = conversation.lastTask else { return nil }
        if let error = task.error { return TaskErrorText.describe(error) }
        if task.needsAnswer, let question = task.question { return question.displayText }
        if let result = task.displayResult, !result.isEmpty { return result }
        return nil
    }
}
