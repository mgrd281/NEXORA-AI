import SwiftUI
import UIKit

/// Dictation sheet: live transcript and input level, then an editable transcript that is
/// sent as a task with `source: "voice"`. Nothing is sent until the user taps Send.
struct VoiceCaptureView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var model: VoiceCaptureModel? = nil
    /// When set, the request is sent as a follow-up in this conversation.
    let conversationId: String?
    /// Files already uploaded in the composer; sent with the spoken request.
    let attachmentIds: [String]
    let onCreated: (TaskSummary) -> Void

    init(conversationId: String? = nil, attachmentIds: [String] = [], onCreated: @escaping (TaskSummary) -> Void) {
        self.conversationId = conversationId
        self.attachmentIds = attachmentIds
        self.onCreated = onCreated
    }

    var body: some View {
        NavigationStack {
            Group {
                if let model {
                    VoiceCaptureContent(
                        model: model,
                        openSettings: { openSystemSettings() },
                        send: { send(model) }
                    )
                    .task(id: model.attempt) { await run(model) }
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(MeridianColor.canvas)
            .navigationTitle(conversationId == nil ? Text("Speak a request") : Text("Speak a follow-up"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .onAppear {
            if model == nil {
                let identifier = (app.me?.preferences.voice.recognitionLocale ?? .auto).resolvedIdentifier()
                model = VoiceCaptureModel(
                    localeIdentifier: identifier,
                    conversationId: conversationId,
                    attachmentIds: attachmentIds
                )
            }
        }
        .onDisappear {
            model?.dismissed(app: app)
        }
        .interactiveDismissDisabled(model?.phase == .submitting)
    }

    private func run(_ model: VoiceCaptureModel) async {
        await model.run(app: app)
    }

    private func send(_ model: VoiceCaptureModel) {
        Task {
            if let task = await model.send(app: app) {
                dismiss()
                onCreated(task)
            }
        }
    }

    private func openSystemSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            openURL(url)
        }
    }
}

private struct VoiceCaptureContent: View {
    @Bindable var model: VoiceCaptureModel
    let openSettings: () -> Void
    let send: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: MeridianSpace.s6) {
                PresenceView(state: model.presence, diameter: 120)
                    .padding(.top, MeridianSpace.s6)

                switch model.phase {
                case .preparing:
                    ProgressView("Getting ready…")
                case .permissionDenied(let permission):
                    permissionDenied(permission)
                case .unavailable(let message):
                    unavailable(message)
                case .listening, .finishing:
                    listening
                case .review, .submitting:
                    review
                }
            }
            .padding(MeridianSpace.s4)
            .frame(maxWidth: MeridianLayout.contentMaxWidth)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    // MARK: States

    private var languageLine: some View {
        VStack(spacing: MeridianSpace.s1) {
            Text("Language: \(model.languageName)")
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
            Text(model.isOnDevice
                 ? String(localized: "Recognized on this iPhone.")
                 : String(localized: "Recognized by Apple's speech service. JARVIS receives only the text you send."))
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textTertiary)
                .multilineTextAlignment(.center)
        }
    }

    private var listening: some View {
        VStack(spacing: MeridianSpace.s6) {
            languageLine
            Text(model.transcript.isEmpty ? String(localized: "Listening…") : model.transcript)
                .meridianFont(.title3)
                .foregroundStyle(model.transcript.isEmpty ? MeridianColor.textTertiary : MeridianColor.textPrimary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: 120)
                .accessibilityLabel(Text("Transcript"))
                .accessibilityValue(Text(model.transcript))
                .accessibilityAddTraits(.updatesFrequently)
            Button {
                model.stopListening()
            } label: {
                if model.phase == .finishing {
                    ProgressView().tint(MeridianColor.onInk)
                } else {
                    Label("Stop", systemImage: "stop.fill")
                }
            }
            .buttonStyle(.meridianPrimary)
            .disabled(model.phase == .finishing)
        }
    }

    private var review: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s4) {
            languageLine
                .frame(maxWidth: .infinity)
            if let notice = model.notice {
                NoteView(text: notice)
            }
            Text("Check the text, then send it to JARVIS.")
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.textSecondary)
            TextField("Your request", text: $model.transcript, axis: .vertical)
                .lineLimit(3...10)
                .meridianFont(.body)
                .padding(MeridianSpace.s3)
                .background(MeridianColor.surface, in: RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous)
                        .strokeBorder(MeridianColor.borderControl, lineWidth: 1)
                }
                .disabled(model.phase == .submitting)
            if let error = model.errorMessage {
                InlineErrorView(message: error)
            }
            Button {
                send()
            } label: {
                if model.phase == .submitting {
                    ProgressView().tint(MeridianColor.onInk)
                } else {
                    Label("Send", systemImage: MeridianIcon.send)
                }
            }
            .buttonStyle(.meridianPrimary)
            .disabled(model.trimmedTranscript.isEmpty || model.phase == .submitting)

            Button {
                model.tryAgain()
            } label: {
                Label("Speak again", systemImage: MeridianIcon.voice)
            }
            .buttonStyle(.meridianSecondary)
            .disabled(model.phase == .submitting)
        }
    }

    private func permissionDenied(_ permission: VoiceCaptureModel.Permission) -> some View {
        VStack(spacing: MeridianSpace.s4) {
            Text(permission == .microphone
                 ? String(localized: "JARVIS needs microphone access to hear your request.")
                 : String(localized: "JARVIS needs speech recognition access to turn your voice into text."))
                .meridianFont(.title3)
                .foregroundStyle(MeridianColor.textPrimary)
                .multilineTextAlignment(.center)
            Text("You can allow it in Settings. You can always type your request instead.")
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.textSecondary)
                .multilineTextAlignment(.center)
            Button {
                openSettings()
            } label: {
                Text("Open Settings")
            }
            .buttonStyle(.meridianPrimary)
        }
    }

    private func unavailable(_ message: String) -> some View {
        VStack(spacing: MeridianSpace.s4) {
            Text(message)
                .meridianFont(.title3)
                .foregroundStyle(MeridianColor.textPrimary)
                .multilineTextAlignment(.center)
            Button {
                model.tryAgain()
            } label: {
                Text("Try again")
            }
            .buttonStyle(.meridianSecondary)
        }
    }
}
