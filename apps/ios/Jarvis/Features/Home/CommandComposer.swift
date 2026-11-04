import Observation
import SwiftUI

/// Text submission state for a new request (Home) or a follow-up in a conversation.
/// Keeps one idempotency key per distinct submission (text plus attached files), so
/// re-sending after a network failure replays instead of creating a second task.
@MainActor
@Observable
final class ComposerModel {
    var text = ""
    private(set) var isSubmitting = false
    private(set) var errorMessage: String?
    /// Files attached to the next submission (uploaded as they are picked).
    let attachments = AttachmentDraft()

    @ObservationIgnored private var keyedIntent: String?
    @ObservationIgnored private var idempotencyKey = UUID().uuidString

    var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var canSubmit: Bool {
        !isSubmitting && !trimmed.isEmpty && trimmed.contractLength <= 4000 && attachments.blockingReason == nil
    }

    /// Sends the text (and ready files) as a new task, or as a follow-up when
    /// `conversationId` is set.
    func submit(app: AppModel, conversationId: String? = nil) async -> TaskSummary? {
        guard canSubmit else { return nil }
        let request = trimmed
        let attachmentIds = attachments.readyIds
        let intent = ([conversationId ?? "", request] + attachmentIds).joined(separator: "\u{1F}")
        if keyedIntent != intent {
            keyedIntent = intent
            idempotencyKey = UUID().uuidString
        }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            let task = try await app.submitTask(
                request,
                source: .text,
                language: AppLocale.current,
                attachmentIds: attachmentIds,
                conversationId: conversationId,
                idempotencyKey: idempotencyKey
            )
            text = ""
            keyedIntent = nil
            attachments.clearAfterSend()
            return task
        } catch is CancellationError {
            return nil
        } catch {
            errorMessage = ErrorText.message(for: error)
            return nil
        }
    }

    /// The request was sent another way (by voice) with the attached files.
    func sentByVoice() {
        attachments.clearAfterSend()
        errorMessage = nil
    }

    func clearError() { errorMessage = nil }
}

/// Text field with attach, microphone and send buttons. Sending creates a task for real;
/// the button stays disabled while the request is in flight or files are still uploading.
struct CommandComposer: View {
    enum Purpose {
        /// A new request (starts a new conversation).
        case newRequest
        /// A follow-up in an existing conversation.
        case followUp
        /// The answer to JARVIS's clarifying question.
        case answer
    }

    @Bindable var model: ComposerModel
    var purpose: Purpose = .newRequest
    /// Whether the attach button is offered.
    var allowsAttachments = true
    /// Focus the field when the composer appears (answering a question).
    var focusOnAppear = false
    /// Changing this focuses the field (for example from an "Answer" button).
    var focusTrigger = 0
    let onSend: () -> Void
    let onVoice: () -> Void

    @FocusState private var isFocused: Bool
    @ScaledMetric(relativeTo: .body) private var buttonSize: CGFloat = 36

    init(
        model: ComposerModel,
        purpose: Purpose = .newRequest,
        allowsAttachments: Bool = true,
        focusOnAppear: Bool = false,
        focusTrigger: Int = 0,
        onSend: @escaping () -> Void,
        onVoice: @escaping () -> Void
    ) {
        self.model = model
        self.purpose = purpose
        self.allowsAttachments = allowsAttachments
        self.focusOnAppear = focusOnAppear
        self.focusTrigger = focusTrigger
        self.onSend = onSend
        self.onVoice = onVoice
    }

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            HStack(alignment: .bottom, spacing: MeridianSpace.s1) {
                TextField(text: $model.text, prompt: prompt, axis: .vertical) {
                    fieldLabel
                }
                .lineLimit(1...6)
                .meridianFont(.body)
                .foregroundStyle(MeridianColor.textPrimary)
                .focused($isFocused)
                .padding(.vertical, MeridianSpace.s2)
                .frame(minHeight: MeridianLayout.minTouchTarget)
                .accessibilityHint(fieldHint)

                if allowsAttachments {
                    AttachButton(draft: model.attachments, size: buttonSize)
                        .disabled(model.isSubmitting)
                }

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
                .disabled(model.isSubmitting || model.attachments.blockingReason != nil)
                .accessibilityLabel(voiceLabel)

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
                .accessibilityLabel(model.isSubmitting ? Text("Sending") : sendLabel)
            }
            .padding(.leading, MeridianSpace.s4)
            .padding(.trailing, MeridianSpace.s1)
            .padding(.vertical, MeridianSpace.s1)
            .background(MeridianColor.surface, in: RoundedRectangle(cornerRadius: MeridianRadius.xl, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: MeridianRadius.xl, style: .continuous)
                    .strokeBorder(isFocused ? MeridianColor.focusRing : MeridianColor.borderControl, lineWidth: isFocused ? 2 : 1)
            }

            AttachmentTray(draft: model.attachments)

            if let reason = model.attachments.blockingReason {
                Text(reason)
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
            }

            if let error = model.errorMessage {
                InlineErrorView(message: error) {
                    onSend()
                }
            }
        }
        .onChange(of: focusTrigger) { _, _ in
            isFocused = true
        }
        .task {
            guard focusOnAppear else { return }
            // Give the navigation transition a moment before raising the keyboard.
            try? await Task.sleep(for: .milliseconds(450))
            isFocused = true
        }
    }

    private var prompt: Text {
        switch purpose {
        case .newRequest: Text("Ask JARVIS to do something")
        case .followUp: Text("Ask a follow-up, like “email it to me”")
        case .answer: Text("Write your answer")
        }
    }

    private var fieldLabel: Text {
        switch purpose {
        case .newRequest: Text("Request")
        case .followUp: Text("Follow-up")
        case .answer: Text("Your answer")
        }
    }

    private var fieldHint: Text {
        switch purpose {
        case .newRequest:
            Text("Describe what JARVIS should do. Anything with side effects asks for your approval first.")
        case .followUp, .answer:
            Text("JARVIS sees this conversation's earlier requests and results. It treats results as information, never as instructions.")
        }
    }

    private var voiceLabel: Text {
        switch purpose {
        case .newRequest: Text("Speak a request")
        case .followUp: Text("Speak a follow-up")
        case .answer: Text("Speak your answer")
        }
    }

    private var sendLabel: Text {
        switch purpose {
        case .newRequest: Text("Send request")
        case .followUp: Text("Send follow-up")
        case .answer: Text("Send answer")
        }
    }
}
