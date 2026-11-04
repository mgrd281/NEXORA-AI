import SwiftUI

/// A clarifying question: JARVIS asks instead of inventing missing information. Nothing was
/// done yet; the user's answer is a follow-up in the same conversation. The question is
/// shown in the app's language when the server composed it.
struct QuestionCard<Actions: View>: View {
    let question: AssistantQuestion
    let actions: Actions

    init(question: AssistantQuestion, @ViewBuilder actions: () -> Actions) {
        self.question = question
        self.actions = actions()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s3) {
            Label {
                Text("JARVIS has a question")
            } icon: {
                Image(systemName: MeridianIcon.question)
                    .accessibilityHidden(true)
            }
            .meridianFont(.label)
            .foregroundStyle(MeridianColor.warning)
            .accessibilityAddTraits(.isHeader)

            Text(question.displayText)
                .meridianFont(.bodyStrong)
                .foregroundStyle(MeridianColor.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)

            if let asked = askedFor {
                Text("Asked for: \(asked)")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
            }

            Text("Nothing was done yet. Answer and JARVIS continues in this conversation.")
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            actions
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

    private var askedFor: String? {
        let labels = question.missing.filter { $0 != .unknown }.map(\.label)
        return labels.isEmpty ? nil : labels.formatted(.list(type: .and))
    }
}

extension QuestionCard where Actions == EmptyView {
    init(question: AssistantQuestion) {
        self.init(question: question) { EmptyView() }
    }
}
