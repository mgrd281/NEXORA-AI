import SwiftUI

/// Text field with microphone and send buttons. Sending creates a task for real;
/// the button stays disabled while the request is in flight.
struct CommandComposer: View {
    @Bindable var model: ComposerModel
    let onSend: () -> Void
    let onVoice: () -> Void

    @FocusState private var isFocused: Bool
    @ScaledMetric(relativeTo: .body) private var buttonSize: CGFloat = 36

    init(model: ComposerModel, onSend: @escaping () -> Void, onVoice: @escaping () -> Void) {
        self.model = model
        self.onSend = onSend
        self.onVoice = onVoice
    }

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            HStack(alignment: .bottom, spacing: MeridianSpace.s2) {
                TextField("Ask JARVIS to do something", text: $model.text, axis: .vertical)
                    .lineLimit(1...6)
                    .meridianFont(.body)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .focused($isFocused)
                    .padding(.vertical, MeridianSpace.s2)
                    .frame(minHeight: MeridianLayout.minTouchTarget)
                    .accessibilityLabel(Text("Request"))
                    .accessibilityHint(Text("Describe what JARVIS should do. Anything with side effects asks for your approval first."))

                Button {
                    isFocused = false
                    onVoice()
                } label: {
                    Image(systemName: MeridianIcon.voice)
                        .font(.system(size: buttonSize * 0.45, weight: .semibold))
                        .frame(width: buttonSize, height: buttonSize)
                        .foregroundStyle(MeridianColor.textPrimary)
                        .background(MeridianColor.surfaceSunken, in: Circle())
                        .frame(minWidth: MeridianLayout.minTouchTarget, minHeight: MeridianLayout.minTouchTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(model.isSubmitting)
                .accessibilityLabel(Text("Speak a request"))

                Button {
                    isFocused = false
                    onSend()
                } label: {
                    Group {
                        if model.isSubmitting {
                            ProgressView()
                                .tint(MeridianColor.onInk)
                        } else {
                            Image(systemName: MeridianIcon.send)
                                .font(.system(size: buttonSize * 0.45, weight: .bold))
                        }
                    }
                    .frame(width: buttonSize, height: buttonSize)
                    .foregroundStyle(MeridianColor.onInk)
                    .background(model.canSubmit || model.isSubmitting ? MeridianColor.ink : MeridianColor.borderStrong, in: Circle())
                    .frame(minWidth: MeridianLayout.minTouchTarget, minHeight: MeridianLayout.minTouchTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!model.canSubmit)
                .accessibilityLabel(model.isSubmitting ? Text("Sending") : Text("Send request"))
            }
            .padding(.leading, MeridianSpace.s4)
            .padding(.trailing, MeridianSpace.s1)
            .padding(.vertical, MeridianSpace.s1)
            .background(MeridianColor.surface, in: RoundedRectangle(cornerRadius: MeridianRadius.xl, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: MeridianRadius.xl, style: .continuous)
                    .strokeBorder(isFocused ? MeridianColor.focusRing : MeridianColor.borderControl, lineWidth: isFocused ? 2 : 1)
            }

            if let error = model.errorMessage {
                InlineErrorView(message: error) {
                    onSend()
                }
            }
        }
    }
}
