import SwiftUI
import Observation

@MainActor
@Observable
final class ApprovalDecisionModel {
    private(set) var approval: Approval
    private(set) var deciding: ApprovalDecision?
    private(set) var errorMessage: String?

    init(approval: Approval) {
        self.approval = approval
    }

    var canDecide: Bool {
        approval.status == .pending && !approval.isExpired() && deciding == nil
    }

    /// Sends the decision bound to the exact `actionHash` that is on screen. The key is
    /// derived from the approval and decision, so a double tap or a re-send after a lost
    /// response replays the same decision instead of making a second one.
    func decide(_ decision: ApprovalDecision, api: APIClient) async -> Approval? {
        guard canDecide else { return nil }
        if decision == .approve, !approval.isReviewable { return nil }
        deciding = decision
        errorMessage = nil
        defer { deciding = nil }
        do {
            let updated = try await api.decideApproval(
                id: approval.id,
                decision: decision,
                actionHash: approval.actionHash,
                idempotencyKey: "approval-\(approval.id)-\(decision.rawValue)"
            )
            approval = updated
            return updated
        } catch is CancellationError {
            return nil
        } catch {
            errorMessage = ErrorText.message(for: error)
            return nil
        }
    }
}

/// Shows exactly what an approval allows — for email, the precise sender, recipients,
/// subject and body — and sends Approve/Decline together with its `actionHash`.
struct ApprovalSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var model: ApprovalDecisionModel
    @State private var decidedFeedback = false
    let onDecided: (Approval) -> Void

    init(approval: Approval, onDecided: @escaping (Approval) -> Void) {
        _model = State(initialValue: ApprovalDecisionModel(approval: approval))
        self.onDecided = onDecided
    }

    private var approval: Approval { model.approval }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: MeridianSpace.s6) {
                    summary
                    details
                    reasons
                    if let error = model.errorMessage {
                        InlineErrorView(message: error)
                    }
                }
                .padding(MeridianSpace.s4)
                .frame(maxWidth: MeridianLayout.contentMaxWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .background(MeridianColor.canvas)
            .safeAreaInset(edge: .bottom) { actionBar }
            .navigationTitle(Text("Review action"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .sensoryFeedback(.success, trigger: decidedFeedback)
        }
        .interactiveDismissDisabled(model.deciding != nil)
    }

    // MARK: Sections

    private var summary: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s3) {
            HStack(spacing: MeridianSpace.s2) {
                RiskBadge(level: approval.riskLevel)
                if approval.status != .pending {
                    ToneBadge(label: approval.status.label, systemImage: "info.circle", tone: .neutral)
                }
            }
            Text(approval.displaySummary)
                .meridianFont(.title2)
                .foregroundStyle(MeridianColor.textPrimary)
                .accessibilityAddTraits(.isHeader)
            Text("Part of “\(approval.displayTaskTitle.bidiIsolated)”")
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.textSecondary)
            if approval.isExpired() {
                NoteView(text: String(localized: "This request has expired. Nothing will be done; retry the task to ask again."), systemImage: "timer")
            } else if approval.status == .pending {
                Text("Expires \(MeridianFormat.relative(approval.expiresAt))")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
        }
    }

    @ViewBuilder
    private var details: some View {
        if let untrusted = approval.details.untrusted {
            UntrustedSourceNote(source: untrusted)
        }
        switch approval.details {
        case .email(let email):
            EmailPreview(email: email)
        case .schedule(let action):
            ScheduleActionPreview(action: action)
        case .memory(let action):
            MemoryActionPreview(action: action)
        case .calendarEvent(let action):
            CalendarEventPreview(action: action)
        case .booking(let action):
            BookingPreview(action: action)
        case .purchase(let action):
            PurchasePreview(action: action)
        case .formSubmission(let action):
            FormSubmissionPreview(action: action)
        case .phoneCall(let action):
            PhoneCallPreview(action: action)
        case .generic(let action):
            Card {
                Text(action.toolId.label)
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
                ForEach(action.fields, id: \.self) { field in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(field.label)
                            .meridianFont(.caption)
                            .foregroundStyle(MeridianColor.textSecondary)
                        Text(field.value)
                            .meridianFont(.body)
                            .foregroundStyle(MeridianColor.textPrimary)
                            .textSelection(.enabled)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        case .unknown:
            EmptyView()
        }
        if !approval.isReviewable {
            NoteView(
                text: String(localized: "This version of the app can't show this kind of action, so it can't be approved here. Update the app or review it on the web."),
                systemImage: "exclamationmark.triangle",
                tone: .warning
            )
        }
    }

    @ViewBuilder
    private var reasons: some View {
        let explained = approval.reasons.compactMap(PolicyReasonText.describe)
        if !explained.isEmpty {
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                Text("Why JARVIS is asking")
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
                    .accessibilityAddTraits(.isHeader)
                ForEach(explained, id: \.self) { reason in
                    Label {
                        Text(reason)
                    } icon: {
                        Image(systemName: "shield.lefthalf.filled")
                            .accessibilityHidden(true)
                    }
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textPrimary)
                }
            }
        }
    }

    @ViewBuilder
    private var actionBar: some View {
        if approval.status == .pending, !approval.isExpired() {
            VStack(spacing: MeridianSpace.s2) {
                Button {
                    decide(.approve)
                } label: {
                    if model.deciding == .approve {
                        ProgressView().tint(MeridianColor.onInk)
                    } else {
                        Label(approveLabel, systemImage: MeridianIcon.approve)
                    }
                }
                .buttonStyle(.meridianPrimary)
                .disabled(!model.canDecide || !approval.isReviewable)
                .accessibilityHint(Text("JARVIS performs exactly the action shown"))

                Button {
                    decide(.reject)
                } label: {
                    if model.deciding == .reject {
                        ProgressView()
                    } else {
                        Label("Decline", systemImage: MeridianIcon.reject)
                    }
                }
                .buttonStyle(.meridianDestructive)
                .disabled(!model.canDecide)
                .accessibilityHint(Text(declineHint))
            }
            .padding(MeridianSpace.s4)
            .background(.bar)
        }
    }

    /// What approving does, in words matching the action ("Approve and buy" for a purchase).
    private var approveLabel: String {
        switch approval.details {
        case .email(let email):
            return email.isDraft ? String(localized: "Approve and save draft") : String(localized: "Approve and send")
        case .schedule:
            return String(localized: "Approve and create")
        case .memory:
            return String(localized: "Approve and save")
        case .calendarEvent(let action):
            return action.action == .cancel ? String(localized: "Approve and cancel the event") : String(localized: "Approve and save")
        case .booking:
            return String(localized: "Approve and book")
        case .purchase:
            return String(localized: "Approve and buy")
        case .formSubmission:
            return String(localized: "Approve and submit")
        case .phoneCall:
            return String(localized: "Approve and call")
        case .generic, .unknown:
            return String(localized: "Approve")
        }
    }

    private var declineHint: String {
        switch approval.details {
        case .purchase: String(localized: "Nothing is bought. The task stops at this step.")
        case .booking: String(localized: "Nothing is booked. The task stops at this step.")
        case .calendarEvent: String(localized: "Your calendar isn't changed. The task stops at this step.")
        case .phoneCall: String(localized: "No call is placed. The task stops at this step.")
        case .email(let email) where email.isDraft: String(localized: "No draft is saved. The task stops at this step.")
        default: String(localized: "Nothing is sent. The task stops at this step.")
        }
    }

    private func decide(_ decision: ApprovalDecision) {
        Task {
            if let updated = await model.decide(decision, api: app.api) {
                decidedFeedback.toggle()
                onDecided(updated)
                dismiss()
            }
        }
    }
}

/// The exact email that will be sent (or saved as a draft), and how.
private struct EmailPreview: View {
    let email: ApprovalDetails.Email

    var body: some View {
        if email.isDraft {
            NoteView(text: String(localized: "This saves a draft in your mailbox. Nothing is sent; you can review and send it yourself later."), systemImage: "square.and.pencil")
        }
        Card {
            DetailRow(label: String(localized: "From"), value: email.from)
            if let via = viaText {
                Divider().overlay(MeridianColor.border)
                DetailRow(label: email.isDraft ? String(localized: "Saved in") : String(localized: "Sent through"), value: via)
            }
            Divider().overlay(MeridianColor.border)
            DetailRow(label: String(localized: "To"), value: email.to.joined(separator: ", "))
            if let cc = email.cc, !cc.isEmpty {
                Divider().overlay(MeridianColor.border)
                DetailRow(label: String(localized: "Cc"), value: cc.joined(separator: ", "))
            }
            if let thread = email.inReplyTo {
                Divider().overlay(MeridianColor.border)
                // The thread's subject comes from the mailbox (written by others).
                DetailRow(label: String(localized: "In reply to"), value: thread.subject.isEmpty ? String(localized: "(no subject)") : thread.subject.bidiIsolated)
            }
            Divider().overlay(MeridianColor.border)
            DetailRow(label: String(localized: "Subject"), value: email.subject)
            Divider().overlay(MeridianColor.border)
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                Text("Message")
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
                Text(email.body)
                    .meridianFont(.body)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var viaText: String? {
        switch email.via {
        case .smtp: String(localized: "Your SMTP mail server")
        case .google: String(localized: "Your Google account (Gmail)")
        case .microsoft: String(localized: "Your Microsoft account (Outlook)")
        case .unknown: String(localized: "A way this version of the app doesn't know")
        case .none: nil
        }
    }
}

/// A schedule JARVIS will create: the exact request each run carries out, when it runs (in
/// the schedule's zone) and the stored rule. Nothing about the runs is approved in advance.
private struct ScheduleActionPreview: View {
    let action: ApprovalDetails.ScheduleAction

    var body: some View {
        Card {
            DetailRow(label: String(localized: "Name"), value: action.title)
            Divider().overlay(MeridianColor.border)
            DetailRow(label: String(localized: "Each run asks"), value: action.request)
            Divider().overlay(MeridianColor.border)
            DetailRow(label: String(localized: "Repeats"), value: RecurrenceText.describe(action.recurrence))
            Divider().overlay(MeridianColor.border)
            DetailRow(label: String(localized: "Time zone"), value: RecurrenceText.zoneName(action.recurrence.timeZone))
            if !action.nextOccurrences.isEmpty {
                Divider().overlay(MeridianColor.border)
                VStack(alignment: .leading, spacing: MeridianSpace.s1) {
                    Text("Next runs")
                        .meridianFont(.label)
                        .foregroundStyle(MeridianColor.textSecondary)
                    ForEach(action.nextOccurrences, id: \.self) { date in
                        Text(RecurrenceText.occurrence(date, zone: action.recurrence.timeZone))
                            .meridianFont(.body)
                            .foregroundStyle(MeridianColor.textPrimary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            Divider().overlay(MeridianColor.border)
            DetailRow(label: String(localized: "Rule (RFC 5545)"), value: action.rrule, monospaced: true)
        }
        NoteView(text: String(localized: "Nothing is approved in advance: every run is planned and checked on its own, and anything that needs your approval will ask you then."))
    }
}

/// Text from an earlier result that JARVIS would keep in memory, exactly as it will be saved.
private struct MemoryActionPreview: View {
    let action: ApprovalDetails.MemoryAction

    var body: some View {
        Card {
            DetailRow(label: String(localized: "Will be saved"), value: action.content)
            Divider().overlay(MeridianColor.border)
            DetailRow(label: String(localized: "Kind"), value: action.memoryKind.label)
            if action.sourceTaskId != nil {
                Divider().overlay(MeridianColor.border)
                DetailRow(label: String(localized: "Taken from"), value: String(localized: "The result of an earlier task"))
            }
        }
        NoteView(text: String(localized: "JARVIS keeps exactly this text. You can delete it in Memory later."))
    }
}

/// Facts about content flagged as a suspected prompt injection (never the text itself).
private struct UntrustedSourceNote: View {
    let source: UntrustedSource

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            Label {
                Text(headline)
            } icon: {
                Image(systemName: "exclamationmark.triangle")
                    .accessibilityHidden(true)
            }
            .meridianFont(.bodyStrong)
            .foregroundStyle(MeridianColor.danger)
            if let excluded = source.excludedSentences, excluded > 0 {
                Text("JARVIS left that text out of the summary.")
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textPrimary)
            }
            Text("Check the details carefully before you approve.")
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.textPrimary)
        }
        .padding(MeridianSpace.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MeridianColor.dangerSoft, in: RoundedRectangle(cornerRadius: MeridianRadius.lg, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private var headline: String {
        if let host = source.host, !host.isEmpty {
            return String(localized: "Text on \(host.bidiIsolated) tried to give instructions to AI assistants.")
        }
        return String(localized: "A source used for this tried to give instructions to AI assistants.")
    }
}

/// A labelled value in an approval preview; values are selectable so they can be checked.
struct DetailRow: View {
    let label: String
    let value: String
    var monospaced = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
            Text(value)
                .meridianFont(monospaced ? .mono : .body)
                .foregroundStyle(MeridianColor.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
