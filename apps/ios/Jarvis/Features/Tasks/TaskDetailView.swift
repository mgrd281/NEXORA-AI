import SwiftUI

struct TaskDetailView: View {
    @Environment(AppModel.self) private var app
    @State private var model: TaskDetailModel
    @State private var reviewing: Approval? = nil
    @State private var confirmingCancel = false
    @State private var confirmingRetry = false
    @State private var confirmingUnknownOutcomeRetry = false
    private let showsConversationLink: Bool

    init(taskId: String, showsConversationLink: Bool = true) {
        _model = State(initialValue: TaskDetailModel(taskId: taskId))
        self.showsConversationLink = showsConversationLink
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MeridianSpace.s6) {
                if let detail = model.detail {
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
            .padding(.horizontal, MeridianSpace.s4)
            .padding(.vertical, MeridianSpace.s4)
            .frame(maxWidth: MeridianLayout.contentMaxWidth)
            .frame(maxWidth: .infinity)
        }
        .background(MeridianColor.canvas)
        .navigationTitle(Text("Task"))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .task { await reload() }
        .task { await followEvents() }
        .onChange(of: app.live.openCount) { _, _ in
            model.scheduleRefresh(api: app.api)
        }
        .sheet(item: $reviewing) { approval in
            ApprovalSheet(approval: approval) { _ in
                model.scheduleRefresh(api: app.api)
            }
        }
        .confirmationDialog(Text("Cancel this task?"), isPresented: $confirmingCancel, titleVisibility: .visible) {
            Button("Cancel task", role: .destructive) {
                Task { await model.cancel(api: app.api) }
            }
            Button("Keep it running", role: .cancel) {}
        } message: {
            Text("JARVIS stops before its next step. Steps that already finished are not undone.")
        }
        .confirmationDialog(Text("Retry this task?"), isPresented: $confirmingRetry, titleVisibility: .visible) {
            Button("Retry") {
                Task { await model.retry(api: app.api, acknowledgeUnknownOutcome: false) }
            }
            Button("Not now", role: .cancel) {}
        } message: {
            Text("JARVIS runs it again from the step that didn't finish.")
        }
        .alert(Text("The last attempt may have worked"), isPresented: $confirmingUnknownOutcomeRetry) {
            Button("Retry anyway", role: .destructive) {
                Task { await model.retry(api: app.api, acknowledgeUnknownOutcome: true) }
            }
            Button("Don't retry", role: .cancel) {}
        } message: {
            Text("JARVIS couldn't confirm whether the last action took effect. For example, an email may already have been sent. Retrying could do it a second time.")
        }
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ detail: TaskDetail) -> some View {
        // Split in two so no builder block has more than ten children.
        outcomeParts(detail)
        detailParts(detail)
    }

    @ViewBuilder
    private func outcomeParts(_ detail: TaskDetail) -> some View {
        header(detail)

        Card {
            Text("Your request")
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
            Text(detail.request)
                .meridianFont(.body)
                .foregroundStyle(MeridianColor.textPrimary)
                .textSelection(.enabled)
            if let attachments = detail.attachments, !attachments.isEmpty {
                AttachedFilesView(attachments: attachments)
            }
        }

        if let approval = detail.pendingApproval, approval.status == .pending {
            ApprovalCard(approval: approval) {
                reviewing = approval
            }
        }

        if detail.needsAnswer, let question = detail.question {
            QuestionCard(question: question) {
                NavigationLink(value: ConversationRoute(id: detail.conversationId, answering: true)) {
                    Label("Reply", systemImage: MeridianIcon.question)
                }
                .buttonStyle(.meridianPrimary)
                .accessibilityHint(Text("Opens the conversation with the reply field ready"))
            }
        } else if let answer = model.answer {
            Card {
                Text("Answer")
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
                Text(answer)
                    .meridianFont(.body)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .textSelection(.enabled)
            }
        } else if let result = detail.displayResult, !result.isEmpty {
            Card {
                Text("Result")
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
                Text(result)
                    .meridianFont(.body)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .textSelection(.enabled)
            }
        }

        ForEach(model.linkedOrders) { order in
            OrderCard(order: order)
        }
        ForEach(model.linkedBookings) { booking in
            BookingCard(booking: booking)
        }

        if let error = detail.error {
            errorCard(error, unknownOutcome: detail.hasUnknownOutcome)
            TaskErrorActions(error: error, detail: detail) {
                model.scheduleRefresh(api: app.api)
            }
        }
    }

    @ViewBuilder
    private func detailParts(_ detail: TaskDetail) -> some View {
        actions(detail)

        links(detail)

        if !detail.steps.isEmpty {
            VStack(alignment: .leading, spacing: MeridianSpace.s3) {
                SectionHeader(title: String(localized: "Steps"), count: detail.steps.count)
                ForEach(detail.steps) { step in
                    StepCard(step: step)
                }
            }
        }

        if let sessions = detail.browserSessions, !sessions.isEmpty {
            BrowserSessionsSection(sessions: sessions)
        }

        if !detail.evidence.isEmpty {
            VStack(alignment: .leading, spacing: MeridianSpace.s3) {
                SectionHeader(title: String(localized: "Evidence"), count: detail.evidence.count)
                Card {
                    ForEach(Array(detail.evidence.enumerated()), id: \.offset) { item in
                        EvidenceRow(evidence: item.element)
                    }
                }
            }
        }

        if !detail.events.isEmpty {
            VStack(alignment: .leading, spacing: MeridianSpace.s3) {
                SectionHeader(title: String(localized: "History"), count: nil)
                Card {
                    ForEach(detail.events) { event in
                        HistoryRow(event: event)
                    }
                }
            }
        }

        detailsCard(detail)
    }

    private func header(_ detail: TaskDetail) -> some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s3) {
            Text(detail.displayTitle)
                .meridianFont(.title1)
                .foregroundStyle(MeridianColor.textPrimary)
                .accessibilityAddTraits(.isHeader)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: MeridianSpace.s2) { headerBadges(detail) }
                VStack(alignment: .leading, spacing: MeridianSpace.s2) { headerBadges(detail) }
            }
            if detail.status.isActive, let fraction = detail.progress.fraction {
                ProgressView(value: fraction) {
                    Text("Step \(detail.progress.completed.formatted()) of \(detail.progress.total.formatted())")
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textSecondary)
                }
                .tint(MeridianColor.accent)
            }
            Text(verbatim: "\(detail.source.label) · \(MeridianFormat.dateTime(detail.createdAt))")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textTertiary)
        }
    }

    @ViewBuilder
    private func headerBadges(_ detail: TaskDetail) -> some View {
        StatusBadge(status: detail.status, outcome: detail.outcome)
        RiskBadge(level: detail.riskLevel)
    }

    private func errorCard(_ error: TaskError, unknownOutcome: Bool) -> some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            Label {
                Text(ErrorText.title(for: error.code))
            } icon: {
                Image(systemName: "exclamationmark.triangle")
            }
            .meridianFont(.bodyStrong)
            .foregroundStyle(MeridianColor.danger)
            Text(TaskErrorText.describe(error))
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.textPrimary)
                .textSelection(.enabled)
            if unknownOutcome {
                Text("JARVIS can't tell whether this action took effect. Check before retrying, so it isn't done twice.")
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textPrimary)
            } else if error.retryable {
                Text("It's safe to retry.")
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
        }
        .padding(MeridianSpace.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MeridianColor.dangerSoft, in: RoundedRectangle(cornerRadius: MeridianRadius.lg, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func actions(_ detail: TaskDetail) -> some View {
        if detail.canCancel || detail.canRetry || model.actionError != nil {
            VStack(spacing: MeridianSpace.s3) {
                if let error = model.actionError {
                    InlineErrorView(message: error)
                }
                if detail.canRetry {
                    Button {
                        if detail.hasUnknownOutcome {
                            confirmingUnknownOutcomeRetry = true
                        } else {
                            confirmingRetry = true
                        }
                    } label: {
                        Label("Retry", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.meridianPrimary)
                    .disabled(model.isPerformingAction)
                }
                if detail.canCancel {
                    Button {
                        confirmingCancel = true
                    } label: {
                        Label("Cancel task", systemImage: "xmark.circle")
                    }
                    .buttonStyle(.meridianDestructive)
                    .disabled(model.isPerformingAction)
                }
            }
        }
    }

    /// Where this task belongs: its conversation (follow-ups happen there) and its schedule.
    @ViewBuilder
    private func links(_ detail: TaskDetail) -> some View {
        if showsConversationLink || detail.scheduleId != nil {
            VStack(spacing: MeridianSpace.s2) {
                if showsConversationLink, detail.status.isTerminal, !detail.needsAnswer {
                    NavigationLink(value: ConversationRoute(id: detail.conversationId, answering: true)) {
                        Label("Follow up", systemImage: "arrowshape.turn.up.left")
                    }
                    .buttonStyle(.meridianPrimary)
                    .accessibilityHint(Text("Opens the conversation with the reply field ready"))
                }
                if showsConversationLink {
                    NavigationLink(value: ConversationRoute(id: detail.conversationId)) {
                        Label("Open conversation", systemImage: MeridianIcon.conversations)
                    }
                    .buttonStyle(.meridianSecondary)
                    .accessibilityHint(Text("Shows this request with its follow-ups, where you can send another"))
                }
                if let scheduleId = detail.scheduleId {
                    NavigationLink(value: ScheduleRoute(id: scheduleId)) {
                        Label("Open schedule", systemImage: MeridianIcon.schedules)
                    }
                    .buttonStyle(.meridianSecondary)
                }
            }
        }
    }

    private func detailsCard(_ detail: TaskDetail) -> some View {
        Card {
            Text("Details")
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
            LabeledContent {
                Text(plannerText(detail.planner))
            } label: {
                Text("Planned by")
            }
            LabeledContent {
                Text(MeridianFormat.usd(micro: detail.cost.actualMicroUsd))
            } label: {
                Text("Cost so far")
            }
            LabeledContent {
                Text(MeridianFormat.usd(micro: detail.cost.estimatedMicroUsd))
            } label: {
                Text("Estimated cost")
            }
            if let completed = detail.completedAt {
                LabeledContent {
                    Text(MeridianFormat.dateTime(completed))
                } label: {
                    Text("Finished")
                }
            }
        }
        .meridianFont(.callout)
        .foregroundStyle(MeridianColor.textPrimary)
    }

    private func plannerText(_ planner: PlannerInfo?) -> String {
        guard let planner else { return String(localized: "Not planned yet") }
        switch planner.mode {
        case .offline:
            return String(localized: "Offline rules engine")
        case .model:
            let name = [planner.provider, planner.model].compactMap { $0 }.joined(separator: " · ")
            return name.isEmpty ? String(localized: "AI model") : name
        case .unknown:
            return String(localized: "Unknown planner")
        }
    }

    // MARK: Actions

    private func reload() async {
        await model.load(api: app.api)
    }

    private func followEvents() async {
        for await event in app.live.updates() {
            model.handle(event, api: app.api)
        }
    }
}

// MARK: - Steps, evidence and history

private struct StepCard: View {
    let step: TaskStep
    @State private var showsDetails = false

    var body: some View {
        Card {
            HStack(alignment: .firstTextBaseline, spacing: MeridianSpace.s2) {
                Text((step.position + 1).formatted())
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textTertiary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: MeridianSpace.s1) {
                    Text(step.displayTitle)
                        .meridianFont(.bodyStrong)
                        .foregroundStyle(MeridianColor.textPrimary)
                    Text(step.toolId.label)
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textSecondary)
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: MeridianSpace.s2) { badges }
                VStack(alignment: .leading, spacing: MeridianSpace.s2) { badges }
            }
            if let error = step.error {
                Text(TaskErrorText.describe(error))
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.danger)
            }
            if step.policy.decision == .deny || step.status == .blocked {
                ForEach(step.policy.reasons, id: \.self) { code in
                    if let text = PolicyReasonText.describe(code) {
                        Text(text)
                            .meridianFont(.callout)
                            .foregroundStyle(MeridianColor.textSecondary)
                    }
                }
            }
            StepOutputView(step: step)
            ForEach(Array(step.evidence.enumerated()), id: \.offset) { item in
                EvidenceRow(evidence: item.element)
            }
            if hasDetails {
                DisclosureGroup(isExpanded: $showsDetails) {
                    VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                        fields(step.inputPreview, title: String(localized: "Input"))
                        if let output = step.output {
                            fields(output, title: String(localized: "Output"))
                        }
                    }
                    .padding(.top, MeridianSpace.s2)
                } label: {
                    Text("Details")
                        .meridianFont(.label)
                }
                .tint(MeridianColor.textSecondary)
            }
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var badges: some View {
        StepStatusBadge(status: step.status)
        RiskBadge(level: step.riskLevel)
        if step.attempts > 1 {
            Text("Attempts: \(step.attempts.formatted())")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
        }
    }

    private var hasDetails: Bool {
        !step.inputPreview.isEmpty || !(step.output?.isEmpty ?? true)
    }

    private func fields(_ values: [String: JSONValue], title: String) -> some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s1) {
            Text(title)
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
            ForEach(values.keys.sorted(), id: \.self) { key in
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: key)
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textTertiary)
                    Text(values[key]?.displayText ?? "")
                        .meridianFont(.mono)
                        .foregroundStyle(MeridianColor.textPrimary)
                        .textSelection(.enabled)
                        .lineLimit(12)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

struct EvidenceRow: View {
    let evidence: Evidence

    var body: some View {
        HStack(alignment: .top, spacing: MeridianSpace.s3) {
            Image(systemName: evidence.kind.icon)
                .foregroundStyle(MeridianColor.success)
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(EvidenceText.title(evidence))
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textPrimary)
                Text(evidence.value)
                    .meridianFont(evidence.kind == .contentHash ? .mono : .callout)
                    .foregroundStyle(MeridianColor.textSecondary)
                    .textSelection(.enabled)
                    .lineLimit(6)
                Text(MeridianFormat.dateTime(evidence.at))
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textTertiary)
                if let artifactId = evidence.artifactId {
                    EvidenceFileButton(
                        artifactId: artifactId,
                        title: String(localized: "Open the file"),
                        systemImage: evidence.code == "ICS_FILE" ? "calendar" : "doc.viewfinder"
                    )
                    .padding(.top, MeridianSpace.s1)
                }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .contain)
    }
}

private struct HistoryRow: View {
    let event: TaskEvent

    var body: some View {
        HStack(alignment: .top, spacing: MeridianSpace.s3) {
            Image(systemName: TaskEventText.icon(event.type))
                .foregroundStyle(MeridianColor.textTertiary)
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(TaskEventText.describe(event.type, data: event.data))
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textPrimary)
                Text(event.at.formatted(date: .abbreviated, time: .standard))
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textTertiary)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}
