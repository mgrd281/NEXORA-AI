import SwiftUI

/// A surface with a hairline border (Meridian prefers borders over shadows).
struct Card<Content: View>: View {
    var padding: CGFloat = MeridianSpace.s4
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s3) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(padding)
        .background(MeridianColor.surface, in: RoundedRectangle(cornerRadius: MeridianRadius.lg, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: MeridianRadius.lg, style: .continuous)
                .strokeBorder(MeridianColor.border, lineWidth: 1)
        }
    }
}

/// Icon + label pill in a semantic tone. Never colour alone.
struct ToneBadge: View {
    let label: String
    let systemImage: String
    let tone: MeridianTone

    var body: some View {
        Label {
            Text(label)
        } icon: {
            Image(systemName: systemImage)
                .accessibilityHidden(true)
        }
        .labelStyle(.titleAndIcon)
        .meridianFont(.label)
        .foregroundStyle(tone.foreground)
        .padding(.horizontal, MeridianSpace.s2)
        .padding(.vertical, MeridianSpace.s1)
        .background(tone.background, in: Capsule())
        .accessibilityElement(children: .combine)
    }
}

struct StatusBadge: View {
    let status: TaskStatus
    /// A completed task that asked a clarifying question reads "Needs your answer", never "Completed".
    var outcome: TaskOutcome? = nil

    var body: some View {
        if status == .completed, outcome == .question {
            ToneBadge(label: TaskOutcome.questionLabel, systemImage: TaskOutcome.questionIcon, tone: .warning)
        } else {
            ToneBadge(label: status.label, systemImage: MeridianIcon.status(status), tone: status.tone)
        }
    }
}

struct StepStatusBadge: View {
    let status: StepStatus

    var body: some View {
        ToneBadge(label: status.label, systemImage: status.icon, tone: status.tone)
    }
}

struct RiskBadge: View {
    let level: RiskLevel

    var body: some View {
        ToneBadge(label: level.label, systemImage: level.icon, tone: level.tone)
    }
}

/// Section title with an optional count, exposed to VoiceOver as a heading.
struct SectionHeader: View {
    let title: String
    var count: Int?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: MeridianSpace.s2) {
            Text(title)
                .meridianFont(.title3)
                .foregroundStyle(MeridianColor.textPrimary)
            if let count {
                Text(count.formatted())
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// An inline error with an optional retry action.
struct InlineErrorView: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: MeridianSpace.s3) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(MeridianColor.danger)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                Text(message)
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                if let retry {
                    Button("Try again", action: retry)
                        .buttonStyle(.borderless)
                        .meridianFont(.label)
                        .frame(minHeight: MeridianLayout.minTouchTarget)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(MeridianSpace.s3)
        .background(MeridianColor.dangerSoft, in: RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

/// A neutral informational note (e.g. offline planner, privacy notes).
struct NoteView: View {
    let text: String
    var systemImage = "info.circle"
    var tone: MeridianTone = .neutral

    var body: some View {
        HStack(alignment: .top, spacing: MeridianSpace.s3) {
            Image(systemName: systemImage)
                .foregroundStyle(tone.foreground)
                .accessibilityHidden(true)
            Text(text)
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(MeridianSpace.s3)
        .background(tone.background, in: RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

// MARK: Buttons

/// Ink-filled primary action.
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        MeridianButtonBody(configuration: configuration, kind: .primary)
    }
}

/// Bordered secondary action. `destructive` uses the danger colour for the label.
struct SecondaryButtonStyle: ButtonStyle {
    var destructive = false

    func makeBody(configuration: Configuration) -> some View {
        MeridianButtonBody(configuration: configuration, kind: destructive ? .destructive : .secondary)
    }
}

/// Rendered as a View so it can read `isEnabled` from the environment.
private struct MeridianButtonBody: View {
    enum Kind {
        case primary
        case secondary
        case destructive
    }

    let configuration: ButtonStyleConfiguration
    let kind: Kind
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        configuration.label
            .meridianFont(.bodyStrong)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, minHeight: MeridianLayout.minTouchTarget)
            .padding(.horizontal, MeridianSpace.s4)
            .padding(.vertical, MeridianSpace.s1)
            .foregroundStyle(foreground)
            .background(background, in: RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous))
            .overlay {
                if kind != .primary {
                    RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous)
                        .strokeBorder(MeridianColor.borderControl, lineWidth: 1)
                }
            }
            .opacity(isEnabled ? 1 : 0.45)
            .contentShape(RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous))
    }

    private var foreground: Color {
        switch kind {
        case .primary: MeridianColor.onInk
        case .secondary: MeridianColor.textPrimary
        case .destructive: MeridianColor.danger
        }
    }

    private var background: Color {
        switch kind {
        case .primary: configuration.isPressed ? MeridianColor.inkHover : MeridianColor.ink
        case .secondary, .destructive: configuration.isPressed ? MeridianColor.surfaceHover : MeridianColor.surface
        }
    }
}

extension ButtonStyle where Self == PrimaryButtonStyle {
    static var meridianPrimary: PrimaryButtonStyle { PrimaryButtonStyle() }
}

extension ButtonStyle where Self == SecondaryButtonStyle {
    static var meridianSecondary: SecondaryButtonStyle { SecondaryButtonStyle() }
    static var meridianDestructive: SecondaryButtonStyle { SecondaryButtonStyle(destructive: true) }
}

// MARK: Formatting

enum MeridianFormat {
    /// Integer micro-dollars as a USD amount.
    static func usd(micro: Int64) -> String {
        let amount = Decimal(micro) / Decimal(1_000_000)
        return amount.formatted(.currency(code: "USD").precision(.fractionLength(2...4)))
    }

    static func relative(_ date: Date) -> String {
        date.formatted(.relative(presentation: .named, unitsStyle: .wide))
    }

    static func dateTime(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .shortened)
    }
}
