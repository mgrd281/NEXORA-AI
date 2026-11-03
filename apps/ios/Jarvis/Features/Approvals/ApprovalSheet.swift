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
            Text(approval.summary)
                .meridianFont(.title2)
                .foregroundStyle(MeridianColor.textPrimary)
                .accessibilityAddTraits(.isHeader)
            Text("Part of “\(approval.taskTitle)”")
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
        switch approval.details {
        case .email(let email):
            EmailPreview(email: email)
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
                        Label("Approve", systemImage: MeridianIcon.approve)
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
                .accessibilityHint(Text("Nothing is sent. The task stops at this step."))
            }
            .padding(MeridianSpace.s4)
            .background(.bar)
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

/// The exact email that will be sent.
private struct EmailPreview: View {
    let email: ApprovalDetails.Email

    var body: some View {
        Card {
            row(label: String(localized: "From"), value: email.from)
            Divider().overlay(MeridianColor.border)
            row(label: String(localized: "To"), value: email.to.joined(separator: ", "))
            Divider().overlay(MeridianColor.border)
            row(label: String(localized: "Subject"), value: email.subject)
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

    private func row(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
            Text(value)
                .meridianFont(.body)
                .foregroundStyle(MeridianColor.textPrimary)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
