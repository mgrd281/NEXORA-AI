import SwiftUI

/// Compact pending-approval summary; "Review" opens the full `ApprovalSheet`.
struct ApprovalCard: View {
    let approval: Approval
    let onReview: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s3) {
            HStack(alignment: .firstTextBaseline, spacing: MeridianSpace.s2) {
                Image(systemName: MeridianIcon.status(.awaitingApproval))
                    .foregroundStyle(MeridianColor.warning)
                    .accessibilityHidden(true)
                Text(approval.displayTaskTitle)
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
                    .lineLimit(2)
                Spacer(minLength: 0)
                RiskBadge(level: approval.riskLevel)
            }
            Text(approval.displaySummary)
                .meridianFont(.bodyStrong)
                .foregroundStyle(MeridianColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            if approval.details.untrusted != nil {
                ToneBadge(
                    label: String(localized: "Untrusted source"),
                    systemImage: "exclamationmark.triangle",
                    tone: .danger
                )
            }
            if approval.isExpired() {
                Text("This request has expired.")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
            } else {
                Text("Expires \(MeridianFormat.relative(approval.expiresAt))")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
            Button {
                onReview()
            } label: {
                Text("Review")
            }
            .buttonStyle(.meridianPrimary)
            .accessibilityHint(Text("Shows exactly what will happen before you approve or decline"))
        }
        .padding(MeridianSpace.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MeridianColor.warningSoft, in: RoundedRectangle(cornerRadius: MeridianRadius.lg, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: MeridianRadius.lg, style: .continuous)
                .strokeBorder(MeridianColor.border, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
    }
}
