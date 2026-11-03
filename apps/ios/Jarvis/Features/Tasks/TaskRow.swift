import SwiftUI

/// One task in a list: title, status, progress and the most relevant detail line.
struct TaskRow: View {
    let task: TaskSummary

    var body: some View {
        HStack(alignment: .top, spacing: MeridianSpace.s3) {
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                Text(task.title)
                    .meridianFont(.bodyStrong)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(3)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: MeridianSpace.s2) { badges }
                    VStack(alignment: .leading, spacing: MeridianSpace.s1) { badges }
                }
                if let detail {
                    Text(detail)
                        .meridianFont(.callout)
                        .foregroundStyle(MeridianColor.textSecondary)
                        .multilineTextAlignment(.leading)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: MeridianSpace.s2)
            Image(systemName: "chevron.forward")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(MeridianColor.textTertiary)
                .accessibilityHidden(true)
        }
        .padding(.vertical, MeridianSpace.s3)
        .frame(minHeight: MeridianLayout.minTouchTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var badges: some View {
        StatusBadge(status: task.status)
        if task.status == .running || task.status == .verifying, task.progress.total > 0 {
            Text("Step \(task.progress.completed.formatted()) of \(task.progress.total.formatted())")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
        }
        Text(MeridianFormat.relative(task.updatedAt))
            .meridianFont(.caption)
            .foregroundStyle(MeridianColor.textTertiary)
    }

    private var detail: String? {
        if let error = task.error { return error.message.isEmpty ? ErrorText.title(for: error.code) : error.message }
        if let result = task.resultSummary, !result.isEmpty { return result }
        if task.status.isActive { return task.request }
        return nil
    }
}
