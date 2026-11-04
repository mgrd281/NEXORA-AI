import SwiftUI

/// One task in a list: title, status, progress and the most relevant detail line.
/// Server-written titles, results and errors are shown in the app's language.
struct TaskRow: View {
    let task: TaskSummary

    var body: some View {
        HStack(alignment: .top, spacing: MeridianSpace.s3) {
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                Text(task.displayTitle)
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
        StatusBadge(status: task.status, outcome: task.outcome)
        if task.status == .running || task.status == .verifying, task.progress.total > 0 {
            Text("Step \(task.progress.completed.formatted()) of \(task.progress.total.formatted())")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
        }
        if let files = task.attachmentCount, files > 0 {
            Label {
                Text("Files: \(files.formatted())")
            } icon: {
                Image(systemName: MeridianIcon.attachment)
                    .accessibilityHidden(true)
            }
            .meridianFont(.caption)
            .foregroundStyle(MeridianColor.textSecondary)
        }
        if task.source == .schedule {
            Label {
                Text("Scheduled")
            } icon: {
                Image(systemName: MeridianIcon.schedules)
                    .accessibilityHidden(true)
            }
            .meridianFont(.caption)
            .foregroundStyle(MeridianColor.textSecondary)
        }
        Text(MeridianFormat.relative(task.updatedAt))
            .meridianFont(.caption)
            .foregroundStyle(MeridianColor.textTertiary)
    }

    private var detail: String? {
        if let error = task.error { return TaskErrorText.describe(error) }
        if task.needsAnswer, let question = task.question { return question.displayText }
        if let result = task.displayResult, !result.isEmpty { return result }
        if task.status.isActive { return task.request }
        return nil
    }
}
