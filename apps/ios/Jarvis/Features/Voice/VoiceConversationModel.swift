import Foundation
import Observation
import Speech

/// The voice conversation screen's model: builds the controller on the live speech seams, sends
/// each request through `AppModel.submitTask` (a new task, then follow-ups), feeds it the task's
/// state from the realtime stream, presents a waiting approval on screen, and records the
/// voice session's metadata (counters only — no audio, no transcript beyond the requests).
@MainActor
@Observable
final class VoiceConversationModel {
    /// Recognition language, BCP-47 ("de-DE").
    let localeIdentifier: String
    /// The conversation the first request continues (opened from a thread), if any.
    let initialConversationId: String?
    /// Files the composer had uploaded; they go with the first request.
    let attachmentIds: [String]

    private(set) var controller: VoiceConversationController?
    /// The text field: typed requests, and utterances that weren't sent.
    var draft = ""
    /// The current turn's task as last fetched (Presence, the approval, "Open this task").
    private(set) var detail: TaskDetail?
    /// The approval shown on screen (approvals are decided by a tap only).
    var reviewing: Approval?
    private(set) var isOnDevice = true

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var recognizer: LiveConversationRecognizer?
    @ObservationIgnored private var synthesizer: LiveConversationSynthesizer?
    @ObservationIgnored private var voiceSessionRecord: Task<VoiceSession?, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var presentedApprovals: Set<String> = []
    @ObservationIgnored private var attachmentsSent = false
    @ObservationIgnored private var recordEnded = false
    @ObservationIgnored private var heardSomething = false

    init(localeIdentifier: String, conversationId: String? = nil, attachmentIds: [String] = []) {
        self.localeIdentifier = localeIdentifier
        initialConversationId = conversationId
        self.attachmentIds = attachmentIds
    }

    var language: AppLocale { AppLocale(recognitionIdentifier: localeIdentifier) }

    var languageName: String {
        Locale.current.localizedString(forIdentifier: localeIdentifier) ?? localeIdentifier
    }

    /// The first stop phrase of the recognition language, for the keyboard / voice hint.
    var stopPhrase: String {
        VoiceLimits.stopPhrases[language]?.first ?? VoiceLimits.stopPhrases[.en]?.first ?? "stop"
    }

    // MARK: Lifecycle

    /// Builds the conversation and starts listening (asks for permissions the first time).
    func start(app: AppModel) async {
        guard controller == nil else { return }
        self.app = app
        app.speaker.stop()
        let voice = app.me?.preferences.voice
        let recognizer = LiveConversationRecognizer()
        let synthesizer = LiveConversationSynthesizer()
        self.recognizer = recognizer
        self.synthesizer = synthesizer
        let locale = localeIdentifier
        let settings = ConversationSettings(
            recognitionLocale: locale,
            language: AppLocale(recognitionIdentifier: locale),
            silenceMs: VoiceLimits.clampSilence(voice?.endOfSpeechSilenceMs ?? VoiceLimits.endOfSpeechSilenceMsDefault),
            rate: VoiceLimits.clampRate(voice?.speakingRate ?? VoiceLimits.speakingRateDefault),
            voiceNames: voice?.voiceNames ?? .defaults
        )
        let dependencies = VoiceConversationController.Dependencies(
            recognizer: recognizer,
            synthesizer: synthesizer,
            clock: SystemConversationClock(),
            requestAccess: { await VoiceConversationModel.requestAccess(localeIdentifier: locale) },
            submit: { [weak self] request in
                guard let self else { throw CancellationError() }
                return try await self.submit(request)
            },
            classify: { VoiceConversationModel.classify($0) },
            describe: { ErrorText.message(for: $0) },
            newKey: { UUID().uuidString },
            copy: Self.copy(),
            settings: settings
        )
        let controller = VoiceConversationController(dependencies: dependencies, conversationId: initialConversationId)
        controller.onDraft = { [weak self] text in self?.appendDraft(text) }
        controller.onEnded = { [weak self] end in self?.conversationEnded(end) }
        recognizer.onInterruption = { [weak controller] began, shouldResume in
            guard let controller else { return }
            if began {
                controller.interrupt()
            } else {
                Task { await controller.interruptionEnded(shouldResume: shouldResume) }
            }
        }
        recognizer.onOutputRouteLost = { [weak controller] in controller?.outputRouteLost() }
        self.controller = controller
        recordVoiceSessionStart(api: app.api)
        await controller.start()
        isOnDevice = recognizer.isOnDevice
    }

    /// End, Esc, leaving the screen. Never cancels a task.
    func close(_ reason: VoiceEndReason) {
        controller?.end(reason)
    }

    /// The app left the foreground (the system stops recording) or came back.
    func scenePhaseChanged(active: Bool) {
        guard let controller, !controller.isEnded else { return }
        if active {
            Task { await controller.interruptionEnded(shouldResume: true) }
        } else {
            controller.interrupt()
        }
    }

    func toggleMic() {
        guard let controller else { return }
        Task { await controller.toggleMic() }
    }

    /// Sends the text field (the text fallback). If it can't go out now, it comes back.
    func sendDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let controller, !text.isEmpty else { return }
        draft = ""
        controller.submitText(text)
        isOnDevice = recognizer?.isOnDevice ?? isOnDevice
    }

    // MARK: Live updates

    func handle(_ event: StreamEvent) {
        guard let controller, let taskId = controller.taskId else { return }
        guard (event.taskId ?? event.data["taskId"]?.stringValue) == taskId else { return }
        if event.type == .taskAnswerDelta {
            if let text = event.data["text"]?.stringValue {
                controller.answerDelta(taskId: taskId, text: text)
            }
            return
        }
        if event.type == .heartbeat { return }
        scheduleRefresh()
    }

    func streamStateChanged(_ state: StreamConnectionState) {
        switch state {
        case .reconnecting: controller?.setStreamDown(true)
        case .open: controller?.setStreamDown(false)
        case .idle, .connecting, .unauthorized: break
        }
    }

    /// Refetches the current task (after events and after the stream reconnected).
    func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }

    private func refresh() async {
        guard let app, let controller, let taskId = controller.taskId, !controller.isEnded else { return }
        guard let fresh = try? await app.api.task(id: taskId), controller.taskId == taskId else { return }
        detail = fresh
        controller.updateTask(Self.view(of: fresh, requestLanguage: localeIdentifier))
        if fresh.status == .awaitingApproval, let approval = fresh.pendingApproval, approval.status == .pending,
           !presentedApprovals.contains(approval.id) {
            presentedApprovals.insert(approval.id)
            reviewing = approval
        }
    }

    /// The task waits for this approval (the "Review and decide" button).
    var pendingApproval: Approval? {
        guard let detail, detail.id == controller?.taskId, detail.status == .awaitingApproval else { return nil }
        return detail.pendingApproval
    }

    // MARK: Presence (real state only)

    var presence: PresenceState {
        guard let controller else { return .idle }
        switch controller.turn {
        case .speaking: return .speaking
        case .ended: return .idle
        case .failed: return .failed
        case .retrying: return .reconnecting
        case .ready, .submitting, .thinking, .awaitingApproval: break
        }
        if controller.streamDown { return .reconnecting }
        switch controller.turn {
        case .awaitingApproval:
            return .awaiting
        case .thinking:
            guard let detail, detail.id == controller.taskId else { return .planning }
            switch detail.status {
            case .running, .verifying: return .running(progress: detail.progress.fraction)
            case .awaitingApproval: return .awaiting
            default: return .planning
            }
        default:
            return controller.mic == .on ? .listening(level: controller.level) : .idle
        }
    }

    // MARK: Sending

    private func submit(_ request: ConversationSubmitRequest) async throws -> ConversationSubmittedTask {
        guard let app else { throw CancellationError() }
        let voiceSessionId = await voiceSessionRecord?.value?.id
        let attachments = attachmentsSent ? [] : attachmentIds
        let task = try await app.submitTask(
            request.text,
            source: request.source,
            language: request.language == .unknown ? nil : request.language,
            voiceSessionId: voiceSessionId,
            attachmentIds: attachments,
            conversationId: request.conversationId,
            idempotencyKey: request.idempotencyKey
        )
        attachmentsSent = true
        heardSomething = true
        // Events of the new task may have gone by before the response: fetch it once.
        scheduleRefresh()
        return ConversationSubmittedTask(id: task.id, conversationId: task.conversationId, status: task.status)
    }

    private func appendDraft(_ text: String) {
        heardSomething = true
        draft = draft.isEmpty ? text : "\(draft) \(text)"
    }

    private func conversationEnded(_ end: ConversationEnd) {
        refreshTask?.cancel()
        recognizer?.shutdown()
        synthesizer?.shutdown()
        recordVoiceSessionEnd(end)
    }

    // MARK: Voice-session metadata (best effort; never blocks or fakes anything)

    private func recordVoiceSessionStart(api: APIClient) {
        guard voiceSessionRecord == nil else { return }
        let locale = localeIdentifier
        let conversationId = initialConversationId
        voiceSessionRecord = Task {
            try? await api.startVoiceSession(locale: locale, mode: .conversation, conversationId: conversationId)
        }
    }

    private func recordVoiceSessionEnd(_ end: ConversationEnd) {
        guard !recordEnded, let record = voiceSessionRecord, let app else { return }
        recordEnded = true
        let api = app.api
        let heard = heardSomething || (controller?.captions.contains { $0.speaker == .user } ?? false)
        let outcome = Self.outcome(of: end, heardSomething: heard)
        Task {
            guard let started = await record.value else { return }
            try? await api.endVoiceSession(
                id: started.id,
                outcome: outcome,
                transcriptChars: end.counters.chars,
                errorCode: end.errorCode,
                counters: end.counters,
                endReason: end.reason
            )
        }
    }

    // MARK: Pure helpers (unit-tested)

    /// `ended` after at least one request; `error` when it ended on one; else whether anything
    /// was heard at all.
    nonisolated static func outcome(of end: ConversationEnd, heardSomething: Bool) -> VoiceSessionEndRequest.Outcome {
        if end.counters.turns > 0 { return .ended }
        if end.reason == .error { return .error }
        return heardSomething ? .cancelled : .noSpeech
    }

    /// 409 CONVERSATION_BUSY → "still busy"; no response, 5xx, 429 or a request still in progress
    /// → retried with the same key; anything else is shown.
    nonisolated static func classify(_ error: any Error) -> ConversationSubmitFailure {
        if let api = error as? ApiError {
            let reason = api.details?["reason"]?.stringValue
            if reason == "CONVERSATION_BUSY" { return .busy }
            switch api.code {
            case .rateLimited, .serviceUnavailable, .internalError:
                return .network
            case .conflict where reason == nil:
                return .network
            default:
                return api.httpStatus >= 500 ? .network : .fatal
            }
        }
        if let network = error as? NetworkError {
            switch network {
            case .offline, .timedOut, .cannotConnect: return .network
            case .invalidResponse, .notSignedIn: return .fatal
            }
        }
        return .fatal
    }

    /// The controller's view of a task.
    static func view(of task: TaskDetail, requestLanguage recognized: String) -> ConversationTaskView {
        let interface = RecognitionLocale.auto.resolvedIdentifier(appLocale: .current)
        // The request's language as the server's planner detected it; else the recognition's.
        let requestLanguage: String
        if let detected = task.language, detected != .unknown {
            requestLanguage = RecognitionLocale.auto.resolvedIdentifier(appLocale: detected)
        } else {
            requestLanguage = recognized
        }
        return ConversationTaskView(
            id: task.id,
            status: task.status,
            conversationId: task.conversationId,
            answer: task.status == .completed ? task.answer : nil,
            answerLanguage: requestLanguage,
            line: replyLine(task, interfaceLanguage: interface, requestLanguage: requestLanguage),
            approvalId: task.status == .awaitingApproval ? task.pendingApproval?.id : nil
        )
    }

    /// What JARVIS says about a task that asks, waits or ended — the same words the task screen
    /// shows (never a client-made claim about an outcome); nil while it works or when the answer
    /// itself is spoken.
    static func replyLine(_ task: TaskDetail, interfaceLanguage: String, requestLanguage: String) -> SpokenLine? {
        switch task.status {
        case .completed:
            if let answer = task.answer, !answer.isEmpty { return nil }
            if let question = task.question {
                if let rendered = question.message?.rendered {
                    return SpokenLine(text: VoiceText.plain(rendered), languageCode: interfaceLanguage, kind: .question)
                }
                return SpokenLine(text: VoiceText.plain(question.text), languageCode: requestLanguage, kind: .question)
            }
            if let rendered = task.resultSummaryMessage?.rendered {
                return SpokenLine(text: VoiceText.plain(rendered), languageCode: interfaceLanguage, kind: .result)
            }
            if let summary = task.resultSummary, !summary.isEmpty {
                return SpokenLine(text: VoiceText.plain(summary), languageCode: requestLanguage, kind: .result)
            }
            return SpokenLine(text: String(localized: "Done."), languageCode: interfaceLanguage, kind: .result)
        case .failed:
            guard let error = task.error else {
                return SpokenLine(text: String(localized: "The task failed."), languageCode: interfaceLanguage, kind: .error)
            }
            let text = "\(ErrorText.title(for: error.code)). \(TaskErrorText.describe(error))"
            return SpokenLine(text: VoiceText.plain(text), languageCode: interfaceLanguage, kind: .error)
        case .cancelled:
            if task.resultSummaryMessage?.key == "result.declined", let rendered = task.resultSummaryMessage?.rendered {
                return SpokenLine(text: VoiceText.plain(rendered), languageCode: interfaceLanguage, kind: .result)
            }
            return SpokenLine(text: String(localized: "The task was cancelled."), languageCode: interfaceLanguage, kind: .result)
        case .expired:
            return SpokenLine(text: String(localized: "The approval expired, so nothing was done."), languageCode: interfaceLanguage, kind: .error)
        case .queued, .planning, .awaitingApproval, .running, .verifying, .unknown:
            return nil
        }
    }

    static func copy() -> ConversationCopy {
        ConversationCopy(
            languageCode: RecognitionLocale.auto.resolvedIdentifier(appLocale: .current),
            approvalOnScreen: String(localized: "This needs your approval. Please review it on screen and tap Approve or Decline — I can't take approvals by voice."),
            busy: String(localized: "I'm still working on your last request. What you just said is in the text field, so you can send it afterwards."),
            idleWarning: String(localized: "Are you still there? I'll end voice mode in a few seconds unless you say something."),
            noMicrophone: String(localized: "No microphone is available. Connect one or close other apps that are recording, then try again."),
            languageUnsupported: String(localized: "Speech recognition isn't available for this language on this iPhone.")
        )
    }

    static func requestAccess(localeIdentifier: String) async -> MicAccess {
        switch await SpeechPermissions.requestSpeechRecognition() {
        case .authorized:
            break
        case .restricted:
            return .restricted
        case .denied, .notDetermined:
            return .deniedSpeech
        @unknown default:
            return .deniedSpeech
        }
        guard await SpeechPermissions.requestMicrophone() else { return .deniedMicrophone }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else {
            return .unavailable(String(localized: "Speech recognition isn't available for this language on this iPhone."))
        }
        guard recognizer.isAvailable else {
            return .unavailable(String(localized: "Speech recognition is unavailable right now. Check your connection and try again."))
        }
        return .granted
    }
}
