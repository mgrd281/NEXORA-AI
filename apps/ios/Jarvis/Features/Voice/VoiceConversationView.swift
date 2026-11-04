import SwiftUI
import UIKit

/// Voice mode: one dictated request (Milestone 1) or a continuous conversation (Phase D),
/// as `preferences.voice.conversationMode` says; either can be switched here.
struct VoiceModeSheet: View {
    @Environment(AppModel.self) private var app
    @State private var conversation: Bool?
    let conversationId: String?
    let attachmentIds: [String]
    /// A dictated request created a task.
    let onCreated: (TaskSummary) -> Void
    /// A conversation ended: the conversation it used (if any) and words left in its text field.
    let onConversationEnded: (_ conversationId: String?, _ draft: String) -> Void

    init(
        conversationId: String? = nil,
        attachmentIds: [String] = [],
        onCreated: @escaping (TaskSummary) -> Void,
        onConversationEnded: @escaping (_ conversationId: String?, _ draft: String) -> Void = { _, _ in }
    ) {
        self.conversationId = conversationId
        self.attachmentIds = attachmentIds
        self.onCreated = onCreated
        self.onConversationEnded = onConversationEnded
    }

    var body: some View {
        Group {
            if conversation ?? (app.me?.preferences.voice.conversationMode ?? false) {
                VoiceConversationView(
                    conversationId: conversationId,
                    attachmentIds: attachmentIds,
                    localeIdentifier: localeIdentifier,
                    onSwitchToDictation: { conversation = false },
                    onEnded: onConversationEnded
                )
            } else {
                VoiceCaptureView(
                    conversationId: conversationId,
                    attachmentIds: attachmentIds,
                    onSwitchToConversation: { conversation = true },
                    onCreated: onCreated
                )
            }
        }
    }

    private var localeIdentifier: String {
        (app.me?.preferences.voice.recognitionLocale ?? .auto).resolvedIdentifier()
    }
}

/// A continuous voice conversation: listen → JARVIS answers aloud, sentence by sentence → listen
/// again. Talking over JARVIS interrupts it. Everything said is captioned; typing works at any
/// time. Approvals are never given by voice — the approval sheet opens and needs a tap.
struct VoiceConversationView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: VoiceConversationModel
    @FocusState private var typing: Bool
    let onSwitchToDictation: () -> Void
    let onEnded: (_ conversationId: String?, _ draft: String) -> Void

    init(
        conversationId: String?,
        attachmentIds: [String],
        localeIdentifier: String,
        onSwitchToDictation: @escaping () -> Void,
        onEnded: @escaping (_ conversationId: String?, _ draft: String) -> Void
    ) {
        _model = State(initialValue: VoiceConversationModel(
            localeIdentifier: localeIdentifier,
            conversationId: conversationId,
            attachmentIds: attachmentIds
        ))
        self.onSwitchToDictation = onSwitchToDictation
        self.onEnded = onEnded
    }

    private var controller: VoiceConversationController? { model.controller }
    private var isEnded: Bool { controller?.isEnded ?? false }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ConversationCaptionsView(model: model)
                ConversationControls(model: model, typing: $typing, openSettings: openSystemSettings)
            }
            .background(MeridianColor.canvas)
            .background { escapeShortcut }
            .navigationTitle(Text("Conversation with JARVIS"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
        }
        .task { await model.start(app: app) }
        .task {
            for await event in app.live.updates() {
                model.handle(event)
            }
        }
        .onChange(of: app.live.state) { _, state in model.streamStateChanged(state) }
        .onChange(of: app.live.openCount) { _, _ in model.scheduleRefresh() }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: model.scenePhaseChanged(active: false)
            case .active: model.scenePhaseChanged(active: true)
            default: break
            }
        }
        .onChange(of: controller?.mic) { _, mic in
            app.isCapturingVoice = mic == .on
        }
        .onChange(of: controller?.turn) { _, turn in
            announce(turn)
        }
        .sheet(item: $model.reviewing) { approval in
            ApprovalSheet(approval: approval) { _ in
                model.scheduleRefresh()
            }
        }
        .onDisappear {
            model.close(.navigation)
            app.isCapturingVoice = false
            onEnded(controller?.conversationId, model.draft)
        }
    }

    // MARK: Toolbar and shortcuts

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button(isEnded ? String(localized: "Close") : String(localized: "End")) {
                model.close(.endButton)
                dismiss()
            }
            .accessibilityLabel(isEnded ? Text("Close") : Text("End conversation"))
            .accessibilityHint(Text("Ends voice mode. A task that is running keeps running."))
        }
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button {
                    model.close(.navigation)
                    onSwitchToDictation()
                } label: {
                    Label("Switch to one request", systemImage: MeridianIcon.voice)
                }
                Button {
                    model.close(.switchedToText)
                    dismiss()
                } label: {
                    Label("Type instead", systemImage: "keyboard")
                }
            } label: {
                Label("Voice mode", systemImage: "ellipsis.circle")
            }
        }
    }

    /// Esc ends the conversation (hardware keyboards); End stays the visible control.
    private var escapeShortcut: some View {
        Button {
            model.close(.escapeKey)
            dismiss()
        } label: {
            EmptyView()
        }
        .keyboardShortcut(.cancelAction)
        .opacity(0)
        .accessibilityHidden(true)
    }

    // MARK: Helpers

    private func announce(_ turn: VoiceTurn?) {
        guard UIAccessibility.isVoiceOverRunning, let turn, let controller else { return }
        switch turn {
        case .ready, .awaitingApproval, .failed, .ended, .retrying:
            let status = ConversationStatusText.describe(turn: turn, mic: controller.mic, notice: controller.notice, streamDown: controller.streamDown)
            UIAccessibility.post(notification: .announcement, argument: status.title)
        case .submitting, .thinking, .speaking:
            // JARVIS's voice (or the captions) carry these; announcing would talk over it.
            break
        }
    }

    private func openSystemSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            openURL(url)
        }
    }
}

/// The state line of the conversation: what is happening and what the user can do.
enum ConversationStatusText {
    struct Status: Equatable {
        let title: String
        let help: String?
    }

    static func describe(turn: VoiceTurn, mic: ConversationMic, notice: ConversationNotice?, streamDown: Bool) -> Status {
        switch turn {
        case .ended:
            return Status(title: String(localized: "Conversation ended"), help: String(localized: "Your requests and JARVIS's answers are in the conversation."))
        case .failed:
            return Status(title: String(localized: "Couldn't send your request."), help: String(localized: "Check your connection. Your words are in the text field — send them when you're back online."))
        case .retrying:
            return Status(title: String(localized: "Connection lost. Trying again…"), help: String(localized: "Your request goes out as soon as JARVIS is reachable — and only once."))
        case .submitting:
            return Status(title: String(localized: "Sending…"), help: nil)
        case .awaitingApproval:
            return Status(title: String(localized: "Waiting for your approval"), help: String(localized: "Review it on screen and tap Approve or Decline. JARVIS never takes approvals by voice."))
        case .speaking:
            return Status(title: String(localized: "Speaking…"), help: String(localized: "Start talking at any time to interrupt."))
        case .thinking:
            if streamDown {
                return Status(title: String(localized: "Reconnecting to live updates…"), help: String(localized: "JARVIS keeps working. The latest state appears as soon as the connection is back."))
            }
            return Status(title: String(localized: "Working on it…"), help: nil)
        case .ready:
            break
        }
        if notice == .interrupted {
            return Status(title: String(localized: "Paused"), help: String(localized: "Another app or a call needed the audio. Tap Listen to continue, or type below."))
        }
        switch mic {
        case .on:
            return Status(title: String(localized: "Listening…"), help: String(localized: "Speak naturally. JARVIS sends what you said after a short pause."))
        case .starting, .off:
            return Status(title: String(localized: "Getting ready…"), help: nil)
        case .muted:
            return Status(title: String(localized: "Microphone off"), help: String(localized: "Turn the microphone on to talk again, or type below."))
        case .denied(let permission):
            return Status(
                title: permission == .microphone
                    ? String(localized: "JARVIS needs microphone access to hear you.")
                    : String(localized: "JARVIS needs speech recognition access to turn your voice into text."),
                help: String(localized: "You can allow it in Settings. You can type below in the meantime.")
            )
        case .restricted:
            return Status(title: String(localized: "Speech recognition is restricted on this iPhone."), help: String(localized: "Type your requests below. JARVIS still answers aloud."))
        case .unavailable(let message):
            return Status(title: message, help: String(localized: "Type your requests below. JARVIS still answers aloud."))
        case .failed:
            return Status(title: String(localized: "Speech recognition stopped working."), help: String(localized: "Check your connection and tap Listen again, or type below."))
        }
    }
}

/// The Presence ring, the state line and the captions of everything said.
private struct ConversationCaptionsView: View {
    let model: VoiceConversationModel

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: MeridianSpace.s4) {
                    ConversationHeader(model: model)
                    captions
                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                }
                .padding(MeridianSpace.s4)
                .frame(maxWidth: MeridianLayout.contentMaxWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.controller?.captions.last?.text) { _, _ in
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
    }

    @ViewBuilder
    private var captions: some View {
        let lines = model.controller?.captions ?? []
        VStack(alignment: .leading, spacing: MeridianSpace.s3) {
            Text("Captions")
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
                .accessibilityAddTraits(.isHeader)
            if lines.isEmpty {
                Text("Say something, or type below. Everything that is said appears here.")
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(lines) { caption in
                CaptionRow(caption: caption)
            }
            if let controller = model.controller, !(controller.heard.isEmpty && controller.interim.isEmpty) {
                HearingRow(text: [controller.heard, controller.interim].filter { !$0.isEmpty }.joined(separator: " "))
            }
        }
    }
}

private struct ConversationHeader: View {
    let model: VoiceConversationModel

    var body: some View {
        let controller = model.controller
        let status = ConversationStatusText.describe(
            turn: controller?.turn ?? .ready,
            mic: controller?.mic ?? .starting,
            notice: controller?.notice,
            streamDown: controller?.streamDown ?? false
        )
        VStack(spacing: MeridianSpace.s3) {
            PresenceView(state: model.presence, diameter: 88)
            Text(status.title)
                .meridianFont(.title3)
                .foregroundStyle(MeridianColor.textPrimary)
                .multilineTextAlignment(.center)
            if let help = status.help {
                Text(help)
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error = controller?.submitError, controller?.turn == .retrying || controller?.turn == .failed || controller?.turn == .ready {
                InlineErrorView(message: error)
            }
            if controller?.notice == .idleWarning {
                NoteView(text: String(localized: "Voice mode ends soon unless you say something."), systemImage: "timer", tone: .warning)
            }
            Text("Language: \(model.languageName) · \(model.isOnDevice ? String(localized: "recognized on this iPhone") : String(localized: "recognized by Apple's speech service")). JARVIS receives only your requests as text — never audio.")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textTertiary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }
}

/// One caption: who said it, the words, and whether it was interrupted, typed or not sent.
private struct CaptionRow: View {
    let caption: ConversationCaption

    private var isUser: Bool { caption.speaker == .user }

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: MeridianSpace.s1) {
            Text(speakerLabel)
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
            Text(verbatim: caption.text)
                .meridianFont(.body)
                .foregroundStyle(MeridianColor.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(MeridianSpace.s3)
                .background(isUser ? MeridianColor.accentSoft : MeridianColor.surface, in: RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous)
                        .strokeBorder(MeridianColor.border, lineWidth: isUser ? 0 : 1)
                }
            if let marker {
                Label {
                    Text(marker)
                } icon: {
                    Image(systemName: markerIcon)
                        .accessibilityHidden(true)
                }
                .meridianFont(.caption)
                .foregroundStyle(caption.unsent || caption.assent ? MeridianColor.warning : MeridianColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        .accessibilityElement(children: .combine)
    }

    private var speakerLabel: String {
        if isUser {
            return caption.typed ? String(localized: "You (typed)") : String(localized: "You")
        }
        return String(localized: "JARVIS")
    }

    private var marker: String? {
        if caption.interrupted { return String(localized: "Interrupted") }
        if caption.assent { return String(localized: "Not an approval — approvals are confirmed on screen") }
        if caption.unsent { return String(localized: "Not sent — it's in the text field") }
        return nil
    }

    private var markerIcon: String {
        if caption.interrupted { return "pause.circle" }
        if caption.assent { return "hand.raised" }
        return "tray.and.arrow.down"
    }
}

/// What is being heard right now (not sent yet).
private struct HearingRow: View {
    let text: String

    var body: some View {
        VStack(alignment: .trailing, spacing: MeridianSpace.s1) {
            Text("Hearing")
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
            Text(verbatim: text)
                .meridianFont(.body)
                .foregroundStyle(MeridianColor.textSecondary)
                .italic()
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// The microphone, the approval and the text field (typing works at any time).
private struct ConversationControls: View {
    @Bindable var model: VoiceConversationModel
    var typing: FocusState<Bool>.Binding
    let openSettings: () -> Void

    private var controller: VoiceConversationController? { model.controller }
    private var isEnded: Bool { controller?.isEnded ?? false }

    var body: some View {
        VStack(spacing: MeridianSpace.s3) {
            if !isEnded {
                HStack(spacing: MeridianSpace.s2) {
                    micButton
                    if let approval = model.pendingApproval {
                        Button {
                            model.reviewing = approval
                        } label: {
                            Label("Review and decide", systemImage: "hand.raised")
                        }
                        .buttonStyle(.meridianPrimary)
                    }
                }
                if needsSettings {
                    Button {
                        openSettings()
                    } label: {
                        Text("Open Settings")
                    }
                    .buttonStyle(.meridianSecondary)
                }
            }
            HStack(alignment: .bottom, spacing: MeridianSpace.s2) {
                TextField(text: $model.draft, prompt: Text("Type instead of speaking…"), axis: .vertical) {
                    Text("Message JARVIS")
                }
                .lineLimit(1...4)
                .meridianFont(.body)
                .focused(typing)
                .submitLabel(.send)
                .onSubmit { model.sendDraft() }
                .padding(.horizontal, MeridianSpace.s3)
                .padding(.vertical, MeridianSpace.s2)
                .frame(minHeight: MeridianLayout.minTouchTarget)
                .background(MeridianColor.surface, in: RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous)
                        .strokeBorder(MeridianColor.borderControl, lineWidth: 1)
                }
                .disabled(isEnded)
                Button {
                    model.sendDraft()
                } label: {
                    Image(systemName: MeridianIcon.send)
                        .font(.system(size: 17, weight: .bold))
                        .frame(width: MeridianLayout.minTouchTarget, height: MeridianLayout.minTouchTarget)
                        .foregroundStyle(MeridianColor.onInk)
                        .background(canSend ? MeridianColor.ink : MeridianColor.borderStrong, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel(Text("Send"))
            }
            Text("Space turns the microphone on or off. Esc ends the conversation. Saying “\(model.stopPhrase)” ends it too.")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(MeridianSpace.s4)
        .frame(maxWidth: MeridianLayout.contentMaxWidth)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }

    private var canSend: Bool {
        !isEnded && !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var needsSettings: Bool {
        if case .denied = controller?.mic { return true }
        return false
    }

    private var micIsOn: Bool { controller?.mic == .on }

    private var micButton: some View {
        Button {
            model.toggleMic()
        } label: {
            Label(
                micIsOn ? String(localized: "Mute") : String(localized: "Listen"),
                systemImage: micIsOn ? "mic.slash" : MeridianIcon.voice
            )
        }
        .buttonStyle(.meridianSecondary)
        .disabled(controller == nil || controller?.mic == .starting)
        .keyboardShortcut(typing.wrappedValue ? nil : KeyboardShortcut(.space, modifiers: []))
        .accessibilityLabel(micIsOn ? Text("Turn microphone off") : Text("Turn microphone on"))
    }
}
