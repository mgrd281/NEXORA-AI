import Foundation
import Observation
import Speech

extension RecognitionLocale {
    /// The BCP-47 identifier to recognise; `auto` follows the app's interface language.
    func resolvedIdentifier(appLocale: AppLocale = .current) -> String {
        switch self {
        case .enUS: "en-US"
        case .deDE: "de-DE"
        case .arSA: "ar-SA"
        case .auto, .unknown:
            switch appLocale {
            case .de: "de-DE"
            case .ar: "ar-SA"
            case .en, .unknown: "en-US"
            }
        }
    }
}

extension AppLocale {
    /// The interface language matching a recognition locale such as "de-DE".
    init(recognitionIdentifier identifier: String) {
        let base = identifier.split(separator: "-").first.map(String.init) ?? identifier
        self = AppLocale(rawValue: base) ?? .en
    }
}

@MainActor
@Observable
final class VoiceCaptureModel {
    enum Permission: Equatable {
        case speech
        case microphone
    }

    enum Phase: Equatable {
        case preparing
        case permissionDenied(Permission)
        case unavailable(String)
        case listening
        /// Audio stopped; waiting for the recognizer's final transcript.
        case finishing
        /// The transcript can be edited and sent.
        case review
        case submitting
    }

    private(set) var phase: Phase = .preparing
    var transcript = ""
    private(set) var level = 0.0
    private(set) var isOnDevice = true
    private(set) var notice: String?
    private(set) var errorMessage: String?
    /// Changing this restarts capture (`.task(id:)` in the view).
    private(set) var attempt = 0
    let localeIdentifier: String
    /// When set, the transcript is sent as a follow-up in this conversation.
    let conversationId: String?

    @ObservationIgnored private var session: SpeechSession?
    @ObservationIgnored private var autoStop: Task<Void, Never>?
    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var voiceSessionRecord: Task<VoiceSession?, Never>?
    @ObservationIgnored private var recordEnded = false
    @ObservationIgnored private var lastFailureCode: String?
    @ObservationIgnored private var keyedTranscript: String?
    @ObservationIgnored private var submissionKey = UUID().uuidString

    /// Longest single dictation before capture stops on its own.
    static let maxDuration: Duration = .seconds(60)

    init(localeIdentifier: String, conversationId: String? = nil) {
        self.localeIdentifier = localeIdentifier
        self.conversationId = conversationId
    }

    var languageName: String {
        Locale.current.localizedString(forIdentifier: localeIdentifier) ?? localeIdentifier
    }

    var requestLanguage: AppLocale { AppLocale(recognitionIdentifier: localeIdentifier) }

    var trimmedTranscript: String { transcript.trimmingCharacters(in: .whitespacesAndNewlines) }

    var presence: PresenceState {
        switch phase {
        case .listening: .listening(level: level)
        case .finishing, .submitting: .planning
        case .permissionDenied, .unavailable: .failed
        case .preparing, .review: .idle
        }
    }

    // MARK: Capture

    /// Asks for permissions (first time only) and captures until the user stops, the
    /// recognizer finishes, or the calling task is cancelled (sheet dismissed).
    func run(app: AppModel) async {
        api = app.api
        let speech = await SpeechPermissions.requestSpeechRecognition()
        switch speech {
        case .authorized:
            break
        case .restricted:
            phase = .unavailable(String(localized: "Speech recognition is restricted on this iPhone."))
            return
        case .denied, .notDetermined:
            phase = .permissionDenied(.speech)
            return
        @unknown default:
            phase = .permissionDenied(.speech)
            return
        }
        guard await SpeechPermissions.requestMicrophone() else {
            phase = .permissionDenied(.microphone)
            return
        }
        guard !Task.isCancelled else { return }
        await listen(app: app)
    }

    private func listen(app: AppModel) async {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else {
            phase = .unavailable(String(localized: "Speech recognition isn't available for \(languageName)."))
            return
        }
        guard recognizer.isAvailable else {
            phase = .unavailable(String(localized: "Speech recognition is unavailable right now. Check your connection and try again."))
            return
        }

        let session = SpeechSession(recognizer: recognizer)
        app.speaker.stop()
        do {
            try session.start()
        } catch {
            phase = .unavailable(String(localized: "The microphone couldn't be started. Close other apps that are recording and try again."))
            return
        }
        self.session = session
        isOnDevice = session.isOnDevice
        transcript = ""
        notice = nil
        errorMessage = nil
        lastFailureCode = nil
        level = 0
        phase = .listening
        app.isCapturingVoice = true
        recordVoiceSessionStart()

        autoStop?.cancel()
        autoStop = Task { [weak self] in
            try? await Task.sleep(for: VoiceCaptureModel.maxDuration)
            guard !Task.isCancelled else { return }
            self?.stopListening()
        }

        var failure: (domain: String, code: Int)?
        for await update in session.updates {
            switch update {
            case .level(let value):
                level = value
            case .transcript(let text, _):
                transcript = text
            case .failed(let domain, let code):
                failure = (domain, code)
            }
        }

        autoStop?.cancel()
        app.isCapturingVoice = false
        level = 0
        self.session = nil
        if Task.isCancelled {
            session.cancel()
            return
        }
        session.stop()

        if trimmedTranscript.isEmpty {
            notice = String(localized: "I didn't catch that. Try again, or close this and type your request.")
            if let failure {
                lastFailureCode = "\(failure.domain):\(failure.code)"
            }
        }
        phase = .review
    }

    /// Stops listening; the final transcript follows shortly.
    func stopListening() {
        guard phase == .listening else { return }
        phase = .finishing
        session?.stop()
    }

    func tryAgain() {
        switch phase {
        case .review, .unavailable:
            phase = .preparing
            attempt += 1
        default:
            return
        }
    }

    /// The sheet is going away without sending.
    func dismissed(app: AppModel) {
        autoStop?.cancel()
        session?.cancel()
        session = nil
        app.isCapturingVoice = false
        if phase != .submitting {
            recordVoiceSessionEnd(
                outcome: trimmedTranscript.isEmpty ? .noSpeech : .cancelled,
                errorCode: lastFailureCode
            )
        }
    }

    // MARK: Sending

    func send(app: AppModel) async -> TaskSummary? {
        let text = trimmedTranscript
        guard phase == .review, !text.isEmpty else { return nil }
        if keyedTranscript != text {
            keyedTranscript = text
            submissionKey = UUID().uuidString
        }
        phase = .submitting
        errorMessage = nil
        let voiceSessionId = await voiceSessionRecord?.value?.id
        do {
            let task = try await app.submitTask(
                text,
                source: .voice,
                language: requestLanguage,
                voiceSessionId: voiceSessionId,
                recognitionLocale: localeIdentifier,
                conversationId: conversationId,
                idempotencyKey: submissionKey
            )
            recordVoiceSessionEnd(outcome: .submitted, errorCode: nil)
            return task
        } catch {
            errorMessage = ErrorText.message(for: error)
            phase = .review
            return nil
        }
    }

    // MARK: Voice-session metadata (best effort; never blocks or fakes anything)

    private func recordVoiceSessionStart() {
        guard voiceSessionRecord == nil, let api else { return }
        let locale = localeIdentifier
        voiceSessionRecord = Task { try? await api.startVoiceSession(locale: locale) }
    }

    private func recordVoiceSessionEnd(outcome: VoiceSessionEndRequest.Outcome, errorCode: String?) {
        guard !recordEnded, let record = voiceSessionRecord, let api else { return }
        recordEnded = true
        let chars = trimmedTranscript.count
        Task {
            guard let started = await record.value else { return }
            try? await api.endVoiceSession(
                id: started.id,
                outcome: outcome,
                transcriptChars: chars,
                errorCode: errorCode
            )
        }
    }
}
