import SwiftUI

/// A conversation thread: per task, the user's request, the task's live state and JARVIS's
/// message, oldest first. The composer at the bottom sends a follow-up (a new task in this
/// conversation, planned with its earlier turns); it is disabled, with the reason, while a
/// task of the conversation is still active.
struct ConversationThreadView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model: ConversationThreadModel
    @State private var composer = ComposerModel()
    @State private var showingVoice = false
    @State private var confirmingDelete = false
    @State private var focusTrigger = 0
    private let answering: Bool

    init(conversationId: String, answering: Bool = false) {
        _model = State(initialValue: ConversationThreadModel(conversationId: conversationId))
        self.answering = answering
    }

    private var items: [ThreadItem] {
        model.turns.compactMap { turn in
            turn.stableId.map { ThreadItem(id: $0, turn: turn) }
        }
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: MeridianSpace.s4) {
                    content
                }
                .padding(.horizontal, MeridianSpace.s4)
                .padding(.vertical, MeridianSpace.s4)
                .frame(maxWidth: MeridianLayout.contentMaxWidth)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: items.last?.id) { _, last in
                guard let last else { return }
                withAnimation(reduceMotion ? nil : Animation.easeOut(duration: MeridianMotion.base)) {
                    proxy.scrollTo(last, anchor: .bottom)
                }
            }
        }
        .background(MeridianColor.canvas)
        .safeAreaInset(edge: .bottom) { composerBar }
        .navigationTitle(Text(model.detail?.displayTitle ?? String(localized: "Conversation")))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button(role: .destructive) {
                        confirmingDelete = true
                    } label: {
                        Label("Delete conversation", systemImage: "trash")
                    }
                    .disabled(model.detail == nil || model.isDeleting)
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
            }
        }
        .refreshable { await model.load(api: app.api) }
        .task { await model.load(api: app.api) }
        .task { await followEvents() }
        .onChange(of: app.live.openCount) { _, _ in
            model.scheduleRefresh(api: app.api)
        }
        .sheet(isPresented: $showingVoice) {
            VoiceModeSheet(
                conversationId: model.conversationId,
                attachmentIds: composer.attachments.readyIds,
                onCreated: { _ in
                    composer.sentByVoice()
                    model.scheduleRefresh(api: app.api)
                },
                onConversationEnded: { _, draft in
                    if !draft.isEmpty, composer.text.isEmpty { composer.text = draft }
                    model.scheduleRefresh(api: app.api)
                }
            )
        }
        .confirmationDialog(Text("Delete this conversation?"), isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete conversation", role: .destructive) {
                Task {
                    if await model.delete(api: app.api) { dismiss() }
                }
            }
            Button("Keep", role: .cancel) {}
        } message: {
            if model.detail?.scheduleId != nil {
                Text("Its requests, results and attached files are deleted. This can't be undone. The schedule that runs it stays; its next run starts a new conversation.")
            } else {
                Text("Its requests, results and attached files are deleted. This can't be undone.")
            }
        }
    }

    // MARK: Turns

    @ViewBuilder
    private var content: some View {
        if model.isGone {
            NoteView(text: String(localized: "This conversation was deleted."), systemImage: "trash")
        } else if model.detail == nil {
            if let error = model.loadError {
                InlineErrorView(message: error) {
                    model.scheduleRefresh(api: app.api)
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, MeridianSpace.s10)
            }
        } else {
            if let error = model.loadError {
                InlineErrorView(message: error) {
                    model.scheduleRefresh(api: app.api)
                }
            }
            if let error = model.deleteError {
                InlineErrorView(message: error)
            }
            if let scheduleId = model.detail?.scheduleId {
                NavigationLink(value: ScheduleRoute(id: scheduleId)) {
                    Label("Runs on a schedule. Open schedule", systemImage: MeridianIcon.schedules)
                }
                .buttonStyle(.meridianSecondary)
            }
            if model.earlierCursor != nil {
                Button {
                    Task { await model.loadEarlier(api: app.api) }
                } label: {
                    if model.isLoadingEarlier {
                        ProgressView()
                    } else {
                        Text("Show earlier requests")
                    }
                }
                .buttonStyle(.meridianSecondary)
                .disabled(model.isLoadingEarlier)
                if let error = model.earlierError {
                    InlineErrorView(message: error)
                }
            }
            ForEach(items) { item in
                turnView(item.turn)
                    .id(item.id)
            }
        }
    }

    @ViewBuilder
    private func turnView(_ turn: ConversationTurn) -> some View {
        switch turn {
        case .userMessage(let message):
            UserMessageBubble(message: message)
        case .task(let task):
            NavigationLink(value: TaskRoute(id: task.id, fromConversation: true)) {
                TaskTurnCard(task: task)
            }
            .buttonStyle(.plain)
        case .assistantMessage(let message):
            assistantView(message)
        case .unknown:
            EmptyView()
        }
    }

    @ViewBuilder
    private func assistantView(_ message: ConversationMessage) -> some View {
        if message.kind == .question, let question = questionFor(message) {
            QuestionCard(question: question) {
                if isOpenQuestion(message), model.detail?.canFollowUp == true {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: MeridianSpace.s2) { questionActions(question) }
                        VStack(spacing: MeridianSpace.s2) { questionActions(question) }
                    }
                }
            }
        } else {
            AssistantMessageBubble(message: message)
        }
    }

    @ViewBuilder
    private func questionActions(_ question: AssistantQuestion) -> some View {
        Button {
            focusTrigger += 1
        } label: {
            Label("Reply", systemImage: "text.cursor")
        }
        .buttonStyle(.meridianPrimary)
        if question.missing.contains(.document) {
            AttachFileButton(draft: composer.attachments)
        }
    }

    /// The question of the task this message belongs to (with what is missing), or a
    /// question built from the message alone.
    private func questionFor(_ message: ConversationMessage) -> AssistantQuestion? {
        for turn in model.turns {
            if case .task(let task) = turn, task.id == message.taskId, let question = task.question {
                return question
            }
        }
        return AssistantQuestion(text: message.text, message: message.textMessage, missing: [.details])
    }

    /// Only the newest task's question can be answered (an answer is the next follow-up).
    private func isOpenQuestion(_ message: ConversationMessage) -> Bool {
        guard model.isAwaitingAnswer else { return false }
        for turn in model.turns.reversed() {
            if case .task(let task) = turn { return task.id == message.taskId }
        }
        return false
    }

    // MARK: Composer

    private var composerBar: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            if let detail = model.detail, !detail.canFollowUp {
                busyNote(detail)
            }
            CommandComposer(
                model: composer,
                purpose: model.isAwaitingAnswer ? .answer : .followUp,
                allowsAttachments: true,
                focusOnAppear: answering,
                focusTrigger: focusTrigger,
                onSend: { send() },
                onVoice: { showingVoice = true }
            )
            .disabled(model.detail?.canFollowUp != true || model.isGone)
        }
        .padding(.horizontal, MeridianSpace.s4)
        .padding(.vertical, MeridianSpace.s2)
        .frame(maxWidth: MeridianLayout.contentMaxWidth)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }

    @ViewBuilder
    private func busyNote(_ detail: ConversationDetail) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: MeridianSpace.s2) {
            Image(systemName: MeridianIcon.status(.running))
                .foregroundStyle(MeridianColor.textSecondary)
                .accessibilityHidden(true)
            if let title = model.activeTaskTitle {
                Text("You can follow up once “\(title.bidiIsolated)” has finished.")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
            } else {
                Text("You can follow up once the current request has finished.")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
            Spacer(minLength: 0)
            if let taskId = detail.activeTaskId {
                NavigationLink(value: TaskRoute(id: taskId, fromConversation: true)) {
                    Text("Open it")
                        .meridianFont(.label)
                        .frame(minHeight: MeridianLayout.minTouchTarget)
                }
            }
        }
    }

    private func send() {
        Task {
            if await composer.submit(app: app, conversationId: model.conversationId) != nil {
                await model.load(api: app.api)
            }
        }
    }

    private func followEvents() async {
        for await event in app.live.updates() {
            model.handle(event, api: app.api)
        }
    }
}

private struct ThreadItem: Identifiable {
    let id: String
    let turn: ConversationTurn
}

/// The user's request, aligned to the trailing edge (mirrors in right-to-left languages).
private struct UserMessageBubble: View {
    let message: ConversationMessage

    var body: some View {
        HStack {
            Spacer(minLength: MeridianSpace.s10)
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                Text("You")
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
                Text(message.displayText)
                    .meridianFont(.body)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if !message.attachments.isEmpty {
                    AttachedFilesView(attachments: message.attachments)
                }
                Text(MeridianFormat.dateTime(message.createdAt))
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textTertiary)
            }
            .padding(MeridianSpace.s3)
            .background(MeridianColor.accentSoft, in: RoundedRectangle(cornerRadius: MeridianRadius.lg, style: .continuous))
        }
        .accessibilityElement(children: .contain)
    }
}

/// What JARVIS said when the task completed: its answer or result line.
private struct AssistantMessageBubble: View {
    let message: ConversationMessage

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                Label {
                    Text(verbatim: "JARVIS")
                } icon: {
                    Image(systemName: message.kind == .answer ? "text.bubble" : "checkmark.circle")
                        .accessibilityHidden(true)
                }
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
                Text(message.displayText)
                    .meridianFont(.body)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Text(MeridianFormat.dateTime(message.createdAt))
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textTertiary)
            }
            .padding(MeridianSpace.s3)
            .background(MeridianColor.surface, in: RoundedRectangle(cornerRadius: MeridianRadius.lg, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: MeridianRadius.lg, style: .continuous)
                    .strokeBorder(MeridianColor.border, lineWidth: 1)
            }
            Spacer(minLength: MeridianSpace.s10)
        }
        .accessibilityElement(children: .contain)
    }
}

/// The task behind a request: live status, progress and what it needs from the user.
/// Opens the task (steps, approvals, evidence).
private struct TaskTurnCard: View {
    let task: TaskSummary

    var body: some View {
        HStack(alignment: .top, spacing: MeridianSpace.s3) {
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                Text(task.displayTitle)
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(2)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: MeridianSpace.s2) { badges }
                    VStack(alignment: .leading, spacing: MeridianSpace.s1) { badges }
                }
                if task.status == .awaitingApproval {
                    Text("Needs your approval. Open the task to review exactly what JARVIS will do.")
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textSecondary)
                } else if let error = task.error {
                    Text(TaskErrorText.describe(error))
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.danger)
                }
            }
            Spacer(minLength: MeridianSpace.s2)
            Image(systemName: "chevron.forward")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(MeridianColor.textTertiary)
                .accessibilityHidden(true)
        }
        .padding(MeridianSpace.s3)
        .frame(minHeight: MeridianLayout.minTouchTarget)
        .background(MeridianColor.surfaceSunken, in: RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("Opens the task"))
    }

    @ViewBuilder
    private var badges: some View {
        StatusBadge(status: task.status, outcome: task.outcome)
        if task.status.isActive, task.progress.total > 0 {
            Text("Step \(task.progress.completed.formatted()) of \(task.progress.total.formatted())")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
        }
    }
}
