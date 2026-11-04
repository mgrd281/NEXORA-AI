import Foundation
import Observation

// Voice conversation mode as a state machine (docs/architecture/phase-d.md §3.1, ADR-0019):
//
//   listen → end of utterance (the configured silence, then the recognizer's final result) →
//   submit (a new task, then follow-ups in the same conversation; one Idempotency-Key per
//   utterance, kept across network retries) → thinking (only while the task really works) →
//   speak the reply sentence by sentence as the streamed answer arrives → listen again.
//
// Barge-in: speech that isn't the echo of what JARVIS is saying stops speaking at once and the
// turn passes to the user. Approvals are never given by voice: while one waits, the controller
// says so and the screen shows the approval sheet. "stop" / "stopp" / "توقف" end voice mode —
// never the task. Idle conversations end after `VoiceLimits.idleEndSeconds` (announced first).
// Recognition restarts after errors with `VoiceLimits.reconnectDelaysMs`.
//
// Pure logic over the seams below (no AVFoundation, no network of its own): the voice screen
// passes `submit` and feeds task updates from the realtime stream; the tests drive it with fake
// recognizers, synthesizers and a manual clock. Only metadata leaves it (the counters).

// MARK: - Seams

/// Why recognition stopped working (mapped by the live recognizer from its errors).
enum RecognitionFailure: Error, Sendable, Equatable {
    /// Nothing was said in this run (the run is simply restarted).
    case noSpeech
    /// Speech recognition permission was withdrawn.
    case notAuthorized
    /// No usable microphone (input unavailable or the audio engine wouldn't start).
    case audioUnavailable
    /// The recognizer doesn't support this language on this device.
    case languageUnsupported
    /// Anything else (network, service, an abort JARVIS didn't ask for): retried with backoff.
    case other(String)
}

/// What one recognition run reports, on the main actor.
enum RecognitionEvent: Sendable, Equatable {
    /// Segments that became final (in order) and the current, still-changing text.
    case result(finals: [String], interim: String)
    /// Microphone input level, 0…1.
    case level(Double)
    case failed(RecognitionFailure)
    /// The run ended (after its final result, an error, `finalize()` or by itself).
    case ended
}

@MainActor
protocol ConversationRecognitionRun: AnyObject {
    /// Stops taking audio for this run; the recognizer delivers its final result, then ends.
    func finalize()
    /// Ends at once, discarding pending audio; no further events.
    func abort()
}

@MainActor
protocol ConversationRecognizer: AnyObject {
    var isSupported: Bool { get }
    /// A run's text covers everything heard since it started (iOS); the controller then starts
    /// a fresh run around JARVIS's speech so its echo never becomes part of a request.
    var isCumulative: Bool { get }
    /// Barge-in by loudness is safe only when JARVIS's voice can't reach the microphone
    /// (headphones). On the speaker, only recognised words that aren't the echo interrupt.
    var allowsLevelBargeIn: Bool { get }
    func start(
        localeIdentifier: String,
        onEvent: @escaping @MainActor @Sendable (RecognitionEvent) -> Void
    ) throws -> any ConversationRecognitionRun
}

@MainActor
protocol ConversationSynthesizer: AnyObject {
    var isSupported: Bool { get }
    /// Speaks one chunk; `onFinish(true)` when done, `onFinish(false)` when it couldn't. Never
    /// called after `cancel()`.
    func speak(
        _ text: String,
        languageCode: String,
        voiceIdentifier: String?,
        rate: Double,
        onFinish: @escaping @MainActor @Sendable (Bool) -> Void
    )
    /// Stops at once and drops anything queued.
    func cancel()
}

@MainActor
protocol ConversationTimer: AnyObject {
    func cancel()
}

@MainActor
protocol ConversationClock: AnyObject {
    /// Monotonic seconds.
    var now: TimeInterval { get }
    func schedule(after milliseconds: Int, _ action: @escaping @MainActor @Sendable () -> Void) -> any ConversationTimer
}

/// The microphone and speech-recognition permissions, asked for once.
enum MicAccess: Sendable, Equatable {
    case granted
    case deniedSpeech
    case deniedMicrophone
    case restricted
    /// Recognition can't run here (no recognizer for the language, service unavailable).
    case unavailable(String)
}

// MARK: - State

/// Where the conversation is (the turn), independent of the microphone.
enum VoiceTurn: Sendable, Equatable {
    case ready
    case submitting
    /// The request didn't go out (network); retried with the same key.
    case retrying
    /// The task is really queued, planning, running or verifying.
    case thinking
    case speaking
    case awaitingApproval
    /// Sending failed after every retry: the words are in the text field.
    case failed
    case ended
}

enum VoicePermission: Sendable, Equatable {
    case speech
    case microphone
}

/// The microphone / recognizer.
enum ConversationMic: Sendable, Equatable {
    case off
    case starting
    case on
    case muted
    case denied(VoicePermission)
    case restricted
    case unavailable(String)
    /// Recognition kept failing after every restart.
    case failed
}

enum ConversationNotice: Sendable, Equatable {
    case busy
    case approvalOnScreen
    case idleWarning
    /// An audio interruption (a phone call, Siri) stopped listening and speaking.
    case interrupted
}

/// A line for JARVIS to say (already localized).
struct SpokenLine: Sendable, Equatable {
    var text: String
    /// BCP-47, e.g. "de-DE".
    var languageCode: String
    var kind: ConversationCaption.Kind
}

/// One line of the captions: what the user said or typed, or what JARVIS said.
struct ConversationCaption: Sendable, Equatable, Identifiable {
    enum Speaker: Sendable, Equatable {
        case user
        case jarvis
    }

    enum Kind: Sendable, Equatable {
        case request
        case answer
        case result
        case question
        case error
        case approval
        case busy
        case notice
    }

    let id: Int
    let speaker: Speaker
    var text: String
    let languageCode: String
    let kind: Kind
    /// JARVIS stopped speaking it because the user spoke (barge-in).
    var interrupted = false
    /// The user typed it (text fallback).
    var typed = false
    /// Not sent (JARVIS was busy or waiting, or sending failed): it went to the text field.
    var unsent = false
    /// Spoken assent while an approval waits: not a decision.
    var assent = false
    var taskId: String?
}

/// The task a turn waits for, as the screen sees it (refetched on every stream event).
struct ConversationTaskView: Sendable, Equatable {
    let id: String
    let status: TaskStatus
    let conversationId: String?
    /// The stored answer once the task completed.
    let answer: String?
    /// BCP-47 of the answer (the request's language).
    let answerLanguage: String
    /// What to say once the task asks, waits or ended (localized); nil while it works.
    let line: SpokenLine?
    /// The pending approval (AWAITING_APPROVAL).
    let approvalId: String?
}

struct ConversationSubmitRequest: Sendable, Equatable {
    let text: String
    let source: TaskRequestSource
    let language: AppLocale
    /// One per utterance, reused for every retry of it.
    let idempotencyKey: String
    /// nil: the first request (a new task); else a follow-up in this conversation.
    let conversationId: String?
}

struct ConversationSubmittedTask: Sendable, Equatable {
    let id: String
    let conversationId: String?
    let status: TaskStatus
}

/// How a failed submit is handled: retried (network), "still busy" (409), or shown.
enum ConversationSubmitFailure: Sendable, Equatable {
    case network
    case busy
    case fatal
}

/// Client copy in the app's language.
struct ConversationCopy: Sendable, Equatable {
    /// BCP-47 of these sentences.
    var languageCode: String
    var approvalOnScreen: String
    var busy: String
    var idleWarning: String
    var noMicrophone: String
    var languageUnsupported: String
}

struct ConversationSettings: Sendable, Equatable {
    /// Recognition language, BCP-47 ("de-DE").
    var recognitionLocale: String
    /// The request language for it.
    var language: AppLocale
    /// End of an utterance: silence after the last words.
    var silenceMs: Int
    var rate: Double
    var voiceNames: Preferences.Voice.VoiceNames
}

struct ConversationEnd: Sendable, Equatable {
    let reason: VoiceEndReason
    let counters: VoiceSessionCounters
    /// The recognizer's last error code, if any (metadata only).
    let errorCode: String?
}

// MARK: - Controller

@MainActor
@Observable
final class VoiceConversationController {
    struct Dependencies {
        var recognizer: any ConversationRecognizer
        var synthesizer: any ConversationSynthesizer
        var clock: any ConversationClock
        var requestAccess: @MainActor @Sendable () async -> MicAccess
        var submit: @MainActor @Sendable (ConversationSubmitRequest) async throws -> ConversationSubmittedTask
        var classify: @MainActor @Sendable (any Error) -> ConversationSubmitFailure
        var describe: @MainActor @Sendable (any Error) -> String
        var newKey: @MainActor @Sendable () -> String
        var copy: ConversationCopy
        var settings: ConversationSettings
        var delaysMs: [Int] = VoiceLimits.reconnectDelaysMs
        var idleEndMs: Int = VoiceLimits.idleEndSeconds * 1_000
        var idleWarnBeforeMs: Int = 10_000
    }

    /// After JARVIS stops speaking, recognition may still deliver its own words for a moment.
    static let echoGraceSeconds: TimeInterval = 1.5
    /// How long the recognizer gets to deliver its final result after the silence.
    static let finalizeGraceMs = 1_500
    /// Barge-in by loudness (headphones only): this level for this long.
    static let bargeInLevel = 0.55
    static let bargeInHoldSeconds: TimeInterval = 0.3
    /// A run that ends sooner than this by itself is retried with backoff, never in a loop.
    static let minimumRunSeconds: TimeInterval = 0.5

    // MARK: Observable state

    private(set) var turn: VoiceTurn = .ready
    private(set) var mic: ConversationMic = .off
    /// The words of the current utterance so far (final) and the still-changing part.
    private(set) var heard = ""
    private(set) var interim = ""
    private(set) var captions: [ConversationCaption] = []
    /// The task of the current turn.
    private(set) var taskId: String?
    private(set) var conversationId: String?
    private(set) var approvalId: String?
    /// The last failure of sending, localized (retrying or given up).
    private(set) var submitError: String?
    private(set) var notice: ConversationNotice?
    /// Live updates are reconnecting, so the state may be behind.
    private(set) var streamDown = false
    /// What is being spoken right now.
    private(set) var speaking: SpokenLine?
    private(set) var counters = VoiceSessionCounters()
    private(set) var endReason: VoiceEndReason?
    /// Microphone level, 0…1 (in steps of 0.05).
    private(set) var level = 0.0

    // MARK: Wiring

    @ObservationIgnored var onEnded: (@MainActor (ConversationEnd) -> Void)?
    /// Puts an utterance that wasn't sent into the text field.
    @ObservationIgnored var onDraft: (@MainActor (String) -> Void)?
    /// The request in flight (tests await it).
    @ObservationIgnored private(set) var inFlight: Task<Void, Never>?

    @ObservationIgnored private var deps: Dependencies

    // Recognition
    @ObservationIgnored private var run: (any ConversationRecognitionRun)?
    @ObservationIgnored private var runId = 0
    @ObservationIgnored private var runStartedAt: TimeInterval = 0
    @ObservationIgnored private var wantRecognition = false
    @ObservationIgnored private var recognitionAttempt = 0
    @ObservationIgnored private var restartTimer: (any ConversationTimer)?
    @ObservationIgnored private var lastErrorCode: String?
    @ObservationIgnored private var utterance: [String] = []
    @ObservationIgnored private var eouTimer: (any ConversationTimer)?
    @ObservationIgnored private var finalizing = false
    @ObservationIgnored private var finalizeTimer: (any ConversationTimer)?
    @ObservationIgnored private var idleWarnTimer: (any ConversationTimer)?
    @ObservationIgnored private var idleEndTimer: (any ConversationTimer)?
    @ObservationIgnored private var loudSince: TimeInterval?
    @ObservationIgnored private var resumeAfterInterruption = false

    // Speaking
    private struct QueuedLine {
        let line: SpokenLine
        let group: String
    }

    private struct CurrentLine {
        let line: SpokenLine
        let group: String
        let captionId: Int
    }

    @ObservationIgnored private var queue: [QueuedLine] = []
    @ObservationIgnored private var current: CurrentLine?
    @ObservationIgnored private var speakGeneration = 0
    @ObservationIgnored private var recentSpoken: [String] = []
    @ObservationIgnored private var lastSpeechEndAt: TimeInterval = -.infinity
    @ObservationIgnored private var lastGroup: (group: String, captionId: Int)?

    // The current turn's task and its streamed answer
    private struct AnswerStream {
        var taskId = ""
        var buffer = ""
        /// UTF-16 offset already split into sentences.
        var taken = 0
        var languageCode = ""
        /// The user interrupted: the rest of this reply isn't spoken (it stays in the task).
        var muted = false
    }

    private struct Pending {
        let id: Int
        var request: ConversationSubmitRequest
        var attempt: Int
        let captionId: Int
    }

    @ObservationIgnored private var task: ConversationTaskView?
    @ObservationIgnored private var views: [String: ConversationTaskView] = [:]
    @ObservationIgnored private var stream = AnswerStream()
    @ObservationIgnored private var finished: Set<String> = []
    @ObservationIgnored private var announcedApprovals: Set<String> = []
    @ObservationIgnored private var pending: Pending?
    @ObservationIgnored private var pendingSequence = 0
    @ObservationIgnored private var retryTimer: (any ConversationTimer)?
    @ObservationIgnored private var captionSequence = 0

    init(dependencies: Dependencies, conversationId: String? = nil) {
        deps = dependencies
        self.conversationId = conversationId
    }

    nonisolated static func isWorking(_ status: TaskStatus) -> Bool {
        status == .queued || status == .planning || status == .running || status == .verifying
    }

    nonisolated static func isFinished(_ status: TaskStatus) -> Bool {
        status == .completed || status == .failed || status == .cancelled || status == .expired
    }

    var isEnded: Bool { turn == .ended }

    // MARK: Inputs

    /// Asks for the permissions (first time only) and starts listening.
    func start() async {
        guard turn != .ended else { return }
        guard deps.recognizer.isSupported else {
            mic = .unavailable(deps.copy.languageUnsupported)
            return
        }
        mic = .starting
        let access = await deps.requestAccess()
        // The conversation may have ended while a permission prompt was open.
        guard turn != .ended else { return }
        switch access {
        case .granted:
            break
        case .deniedSpeech:
            lastErrorCode = "speech-denied"
            mic = .denied(.speech)
            return
        case .deniedMicrophone:
            lastErrorCode = "mic-denied"
            mic = .denied(.microphone)
            return
        case .restricted:
            lastErrorCode = "speech-restricted"
            mic = .restricted
            return
        case .unavailable(let message):
            lastErrorCode = "speech-unavailable"
            mic = .unavailable(message)
            return
        }
        wantRecognition = true
        recognitionAttempt = 0
        startRecognition()
    }

    /// Space / the microphone button: mute or unmute (also "Listen again" after errors).
    func toggleMic() async {
        if mic == .on {
            pause()
        } else {
            await resume()
        }
    }

    /// Mutes the microphone. Words already heard aren't lost: they end the utterance now.
    func pause() {
        guard mic == .on || mic == .starting else { return }
        wantRecognition = false
        cancelRestart()
        stopRecognition()
        if !utterance.isEmpty || !interim.isEmpty {
            if !interim.isEmpty { utterance.append(interim) }
            finishUtterance()
        }
        clearIdle()
        if turn != .ended { mic = .muted }
        interim = ""
        setLevel(0)
    }

    func resume() async {
        guard turn != .ended else { return }
        if mic == .on || mic == .starting { return }
        if turn == .failed {
            setTurn(.ready)
            submitError = nil
        }
        if notice == .interrupted { notice = nil }
        switch mic {
        case .muted:
            wantRecognition = true
            recognitionAttempt = 0
            startRecognition()
        default:
            await start()
        }
    }

    /// Typed text (the text fallback): the same path as speech, `source: text`.
    @discardableResult
    func submitText(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, turn != .ended else { return false }
        if turn == .speaking { bargeIn() }
        clearIdle()
        let sent = handleRequest(trimmed, source: .text)
        if turn == .ready { armIdle() }
        return sent
    }

    /// The current state of a task (refetched on every stream event of it).
    func updateTask(_ view: ConversationTaskView) {
        views[view.id] = view
        guard let active = task, view.id == active.id, turn != .ended else { return }
        task = view
        if let id = view.conversationId, conversationId == nil { conversationId = id }
        if Self.isWorking(view.status) {
            if turn == .awaitingApproval {
                setTurn(.thinking)
                approvalId = nil
            }
            return
        }
        if view.status == .awaitingApproval {
            let key = view.approvalId ?? "\(view.id):approval"
            approvalId = view.approvalId
            if !announcedApprovals.contains(key) {
                announcedApprovals.insert(key)
                notice = .approvalOnScreen
                // Said even after a barge-in: the user must know why nothing happens.
                enqueue(approvalLine, group: "\(view.id):approval:\(key)")
            }
            if turn != .speaking { setTurn(afterSpeech()) }
            return
        }
        guard Self.isFinished(view.status), !finished.contains(view.id) else { return }
        finished.insert(view.id)
        approvalId = nil
        notice = nil
        if !stream.muted {
            if let answer = view.answer, !answer.isEmpty {
                let language = stream.taskId == view.id && !stream.languageCode.isEmpty
                    ? stream.languageCode
                    : view.answerLanguage
                var from = 0
                if stream.taskId == view.id, stream.taken > 0, stream.taken <= stream.buffer.utf16.count {
                    let taken = stream.buffer[..<String.Index(utf16Offset: stream.taken, in: stream.buffer)]
                    if answer.hasPrefix(taken) { from = stream.taken }
                }
                let split = VoiceText.takeSentences(answer, from: from, final: true, languageCode: language)
                for sentence in split.sentences {
                    enqueue(SpokenLine(text: sentence, languageCode: language, kind: .answer), group: "\(view.id):answer")
                }
            } else if let line = view.line {
                enqueue(line, group: "\(view.id):\(line.kind)")
            }
        }
        if turn != .speaking { setTurn(afterSpeech()) }
    }

    /// One `task.answer.delta` of the realtime stream (ephemeral).
    func answerDelta(taskId: String, text: String) {
        guard let active = task, active.id == taskId, turn != .ended else { return }
        guard stream.taskId == taskId, !stream.muted, !finished.contains(taskId) else { return }
        stream.buffer += text
        let split = VoiceText.takeSentences(
            stream.buffer,
            from: stream.taken,
            final: false,
            languageCode: stream.languageCode
        )
        stream.taken = split.next
        for sentence in split.sentences {
            enqueue(SpokenLine(text: sentence, languageCode: stream.languageCode, kind: .answer), group: "\(taskId):answer")
        }
    }

    /// The realtime stream is reconnecting (the screen refetches the task when it is back).
    func setStreamDown(_ down: Bool) {
        if streamDown != down { streamDown = down }
    }

    /// End, Esc, a stop phrase, idle, switching to text, leaving the screen. Never cancels a task.
    func end(_ reason: VoiceEndReason) {
        guard turn != .ended else { return }
        wantRecognition = false
        cancelRestart()
        stopRecognition()
        eouTimer?.cancel()
        eouTimer = nil
        clearIdle()
        retryTimer?.cancel()
        retryTimer = nil
        pending = nil
        stopSpeaking()
        utterance = []
        setTurn(.ended)
        mic = .off
        heard = ""
        interim = ""
        speaking = nil
        endReason = reason
        notice = nil
        setLevel(0)
        onEnded?(ConversationEnd(reason: reason, counters: counters, errorCode: lastErrorCode))
    }

    /// An audio interruption (a phone call, Siri) or the app leaving the foreground: speaking and
    /// listening stop at once. Words heard so far go to the text field — nothing is sent.
    func interrupt() {
        guard turn != .ended else { return }
        resumeAfterInterruption = wantRecognition || resumeAfterInterruption
        if current != nil || !queue.isEmpty {
            let interrupted = current?.captionId
            stopSpeaking()
            stream.muted = true
            markInterrupted(interrupted)
            speaking = nil
            setTurn(afterSpeech(userTurn: true))
        }
        wantRecognition = false
        cancelRestart()
        stopRecognition()
        eouTimer?.cancel()
        eouTimer = nil
        let words = (utterance + (interim.isEmpty ? [] : [interim]))
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        utterance = []
        interim = ""
        heard = ""
        if !words.isEmpty { onDraft?(words) }
        clearIdle()
        setLevel(0)
        if mic == .on || mic == .starting { mic = .muted }
        notice = .interrupted
    }

    /// The interruption is over; listening resumes when the system says so and it was on.
    func interruptionEnded(shouldResume: Bool) async {
        guard turn != .ended else { return }
        let wasListening = resumeAfterInterruption
        resumeAfterInterruption = false
        guard shouldResume, wasListening, mic == .muted else { return }
        await resume()
    }

    /// Headphones were unplugged: stop speaking at once (the audio would switch to the speaker).
    func outputRouteLost() {
        guard turn == .speaking else { return }
        let interrupted = current?.captionId
        stopSpeaking()
        stream.muted = true
        markInterrupted(interrupted)
        speaking = nil
        setTurn(afterSpeech(userTurn: true))
    }

    // MARK: Recognition

    private func startRecognition() {
        guard wantRecognition, run == nil, turn != .ended else { return }
        runId += 1
        let id = runId
        do {
            run = try deps.recognizer.start(localeIdentifier: deps.settings.recognitionLocale) { [weak self] event in
                self?.handleRecognition(event, runId: id)
            }
        } catch let failure as RecognitionFailure {
            run = nil
            onRecognitionError(failure == .noSpeech ? .other("start") : failure)
            return
        } catch {
            run = nil
            onRecognitionError(.other("start"))
            return
        }
        runStartedAt = deps.clock.now
        mic = .on
        if turn == .ready { armIdle() }
    }

    /// Ends the current run without its callbacks (pause, restart, end).
    private func stopRecognition() {
        runId += 1
        let old = run
        run = nil
        finalizing = false
        finalizeTimer?.cancel()
        finalizeTimer = nil
        old?.abort()
    }

    /// A fresh run around JARVIS's speech (cumulative recognizers), unless the user is talking.
    private func restartRunIfCumulative() {
        guard deps.recognizer.isCumulative, wantRecognition, run != nil, utterance.isEmpty, interim.isEmpty else { return }
        stopRecognition()
        startRecognition()
    }

    private func cancelRestart() {
        restartTimer?.cancel()
        restartTimer = nil
    }

    private func handleRecognition(_ event: RecognitionEvent, runId id: Int) {
        guard id == runId, turn != .ended else { return }
        switch event {
        case .result(let finals, let interim):
            onSpeech(finals: finals, interim: interim)
        case .level(let value):
            onLevel(value)
        case .failed(let failure):
            onRecognitionError(failure)
        case .ended:
            run = nil
            onRecognitionEnd()
        }
    }

    private func onRecognitionEnd() {
        if finalizing {
            // The run ended without the final result we asked for: take what was shown.
            finalizing = false
            finalizeTimer?.cancel()
            finalizeTimer = nil
            if !interim.isEmpty {
                utterance.append(interim)
                interim = ""
            }
            finishUtterance()
        } else if !interim.isEmpty {
            // A last interim the recognizer never finalised still counts as heard.
            utterance.append(interim)
            interim = ""
            heard = utterance.joined(separator: " ")
            scheduleEndOfUtterance()
        }
        guard wantRecognition, restartTimer == nil else { return }
        if deps.clock.now - runStartedAt < Self.minimumRunSeconds {
            // A run that ends at once (no audio, a busy service): back off instead of looping.
            onRecognitionError(.other("ended-early"))
            return
        }
        // Recognition ends by itself (silence, service limits): listen again at once.
        startRecognition()
    }

    private func onRecognitionError(_ failure: RecognitionFailure) {
        switch failure {
        case .noSpeech:
            return // `.ended` follows and restarts it.
        case .notAuthorized:
            lastErrorCode = "not-authorized"
            giveUpRecognition(.denied(.speech))
        case .audioUnavailable:
            lastErrorCode = "audio-unavailable"
            giveUpRecognition(.unavailable(deps.copy.noMicrophone))
        case .languageUnsupported:
            lastErrorCode = "language-not-supported"
            giveUpRecognition(.unavailable(deps.copy.languageUnsupported))
        case .other(let code):
            lastErrorCode = String(code.prefix(64))
            let attempt = recognitionAttempt
            guard attempt < deps.delaysMs.count else {
                giveUpRecognition(.failed)
                return
            }
            recognitionAttempt = attempt + 1
            counters.reconnects += 1
            cancelRestart()
            mic = .starting
            restartTimer = deps.clock.schedule(after: deps.delaysMs[attempt]) { [weak self] in
                guard let self else { return }
                self.restartTimer = nil
                self.stopRecognition()
                self.startRecognition()
            }
        }
    }

    private func giveUpRecognition(_ state: ConversationMic) {
        wantRecognition = false
        cancelRestart()
        stopRecognition()
        clearIdle()
        setLevel(0)
        mic = state
    }

    private func onLevel(_ value: Double) {
        setLevel(value)
        guard turn == .speaking, deps.recognizer.allowsLevelBargeIn, value >= Self.bargeInLevel else {
            loudSince = nil
            return
        }
        let now = deps.clock.now
        guard let since = loudSince else {
            loudSince = now
            return
        }
        if now - since >= Self.bargeInHoldSeconds {
            loudSince = nil
            bargeIn()
        }
    }

    private func setLevel(_ value: Double) {
        let stepped = (min(1, max(0, value)) * 20).rounded() / 20
        if stepped != level { level = stepped }
    }

    private func onSpeech(finals: [String], interim rawInterim: String) {
        guard turn != .ended, mic == .on else { return }
        let echoWindow = turn == .speaking || deps.clock.now - lastSpeechEndAt < Self.echoGraceSeconds
        let recent = recentSpoken + (current.map { [$0.line.text] } ?? [])
        let clean: (String) -> String = { text in
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard echoWindow, !trimmed.isEmpty else { return trimmed }
            if VoiceText.isEcho(trimmed, spoken: recent) { return "" }
            return VoiceText.removingEchoPrefix(trimmed, spoken: recent)
        }
        let kept = finals.map(clean).filter { !$0.isEmpty }
        let live = clean(rawInterim)
        if kept.isEmpty, live.isEmpty {
            // Only echo (or nothing). An utterance already heard may still end now.
            if !interim.isEmpty, rawInterim.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                interim = ""
                scheduleEndOfUtterance()
            }
            if finalizing, !finals.isEmpty {
                // The final result we asked for added only JARVIS's own voice.
                finalizing = false
                finalizeTimer?.cancel()
                finalizeTimer = nil
                if !interim.isEmpty {
                    utterance.append(interim)
                    interim = ""
                }
                finishUtterance()
            }
            return
        }
        // Something the user really said: the recognizer works again.
        recognitionAttempt = 0
        if turn == .speaking {
            bargeIn()
            if deps.recognizer.isCumulative {
                // This run's text keeps JARVIS's words: keep what the user said, listen afresh.
                utterance.append(contentsOf: kept)
                if !live.isEmpty { utterance.append(live) }
                interim = ""
                heard = utterance.joined(separator: " ")
                stopRecognition()
                startRecognition()
                resetIdle()
                scheduleEndOfUtterance()
                return
            }
        }
        resetIdle()
        if notice == .idleWarning { notice = nil }
        utterance.append(contentsOf: kept)
        interim = live
        heard = utterance.joined(separator: " ")
        if finalizing, live.isEmpty, !kept.isEmpty {
            // The final result after the silence: the utterance is complete.
            finalizing = false
            finalizeTimer?.cancel()
            finalizeTimer = nil
            finishUtterance()
            return
        }
        // While the final result is on its way, the finalize grace period decides.
        if !finalizing { scheduleEndOfUtterance() }
    }

    /// Re-armed on every change of what is heard; fires after the configured silence.
    private func scheduleEndOfUtterance() {
        eouTimer?.cancel()
        eouTimer = nil
        guard !utterance.isEmpty || !interim.isEmpty else { return }
        eouTimer = deps.clock.schedule(after: deps.settings.silenceMs) { [weak self] in
            guard let self else { return }
            self.eouTimer = nil
            self.endOfUtteranceReached()
        }
    }

    private func endOfUtteranceReached() {
        guard turn != .ended, !finalizing else { return }
        if !interim.isEmpty, let run {
            // Ask the recognizer for the final result of what was said.
            finalizing = true
            run.finalize()
            finalizeTimer?.cancel()
            finalizeTimer = deps.clock.schedule(after: Self.finalizeGraceMs) { [weak self] in
                guard let self, self.finalizing else { return }
                self.finalizeTimer = nil
                self.finalizing = false
                if !self.interim.isEmpty {
                    self.utterance.append(self.interim)
                    self.interim = ""
                }
                // It didn't answer in time: use what it showed, and listen afresh.
                self.stopRecognition()
                self.finishUtterance()
                self.startRecognition()
            }
            return
        }
        if !interim.isEmpty {
            utterance.append(interim)
            interim = ""
        }
        finishUtterance()
    }

    private func finishUtterance() {
        eouTimer?.cancel()
        eouTimer = nil
        let text = utterance.joined(separator: " ")
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        utterance = []
        heard = ""
        interim = ""
        guard !text.isEmpty else { return }
        if VoiceText.isStopPhrase(text, locale: deps.settings.language) {
            end(.voiceCommand)
            return
        }
        handleRequest(text, source: .voice)
    }

    // MARK: Requests

    /// True when the request was sent (or is being sent).
    @discardableResult
    private func handleRequest(_ text: String, source: TaskRequestSource) -> Bool {
        let language = deps.settings.recognitionLocale
        let status = task?.status
        if turn == .awaitingApproval || status == .awaitingApproval {
            // Never a decision: "yes" is answered with "confirm it on screen"; other words wait.
            let assent = VoiceText.isAffirmation(text, locale: deps.settings.language)
            addCaption(
                ConversationCaption(id: 0, speaker: .user, text: text, languageCode: language, kind: .request,
                                    typed: source == .text, unsent: !assent, assent: assent)
            )
            if !assent { onDraft?(text) }
            notice = .approvalOnScreen
            enqueue(approvalLine, group: "notice:\(captionSequence)")
            return false
        }
        if pending != nil || (status.map(Self.isWorking) ?? false) {
            addCaption(
                ConversationCaption(id: 0, speaker: .user, text: text, languageCode: language, kind: .request,
                                    typed: source == .text, unsent: true)
            )
            onDraft?(text)
            sayBusy()
            return false
        }
        let captionId = addCaption(
            ConversationCaption(id: 0, speaker: .user, text: text, languageCode: language, kind: .request,
                                typed: source == .text)
        )
        pendingSequence += 1
        let next = Pending(
            id: pendingSequence,
            request: ConversationSubmitRequest(
                text: text,
                source: source,
                language: deps.settings.language,
                idempotencyKey: deps.newKey(),
                conversationId: conversationId
            ),
            attempt: 0,
            captionId: captionId
        )
        pending = next
        clearIdle()
        setTurn(.submitting)
        submitError = nil
        notice = nil
        send(next)
        return true
    }

    private func send(_ request: Pending) {
        let submit = deps.submit
        let body = request.request
        let id = request.id
        inFlight = Task { [weak self] in
            do {
                let task = try await submit(body)
                self?.submitted(task, pendingId: id)
            } catch {
                self?.submitFailed(error, pendingId: id)
            }
        }
    }

    private func submitted(_ created: ConversationSubmittedTask, pendingId: Int) {
        guard let sent = pending, sent.id == pendingId, turn != .ended else { return }
        pending = nil
        counters.turns += 1
        counters.chars += sent.request.text.count
        task = ConversationTaskView(
            id: created.id,
            status: created.status,
            conversationId: created.conversationId,
            answer: nil,
            answerLanguage: deps.settings.recognitionLocale,
            line: nil,
            approvalId: nil
        )
        stream = AnswerStream(taskId: created.id, buffer: "", taken: 0, languageCode: deps.settings.recognitionLocale, muted: false)
        setCaptionTask(sent.captionId, taskId: created.id)
        taskId = created.id
        conversationId = created.conversationId ?? conversationId
        setTurn(current != nil ? .speaking : .thinking)
        submitError = nil
        // A state the stream delivered before the request was acknowledged.
        if let seen = views[created.id] { updateTask(seen) }
    }

    private func submitFailed(_ error: any Error, pendingId: Int) {
        guard var failed = pending, failed.id == pendingId, turn != .ended else { return }
        let kind = deps.classify(error)
        if kind == .network, failed.attempt < deps.delaysMs.count {
            // The same Idempotency-Key: the server creates the task at most once.
            let delay = deps.delaysMs[failed.attempt]
            failed.attempt += 1
            pending = failed
            counters.reconnects += 1
            submitError = deps.describe(error)
            retryTimer?.cancel()
            retryTimer = deps.clock.schedule(after: delay) { [weak self] in
                guard let self else { return }
                self.retryTimer = nil
                if let again = self.pending, again.id == pendingId { self.send(again) }
            }
            setTurn(.retrying)
            return
        }
        pending = nil
        markUnsent(failed.captionId)
        onDraft?(failed.request.text)
        switch kind {
        case .busy:
            submitError = nil
            setTurn(afterSpeech())
            sayBusy()
        case .network:
            // Retries exhausted: listening ends; the error is shown and the text is in the field.
            wantRecognition = false
            cancelRestart()
            stopRecognition()
            stopSpeaking()
            clearIdle()
            submitError = deps.describe(error)
            if mic == .on || mic == .starting { mic = .off }
            setLevel(0)
            setTurn(.failed)
        case .fatal:
            submitError = deps.describe(error)
            setTurn(afterSpeech())
        }
    }

    private var approvalLine: SpokenLine {
        SpokenLine(text: deps.copy.approvalOnScreen, languageCode: deps.copy.languageCode, kind: .approval)
    }

    private func sayBusy() {
        notice = .busy
        enqueue(SpokenLine(text: deps.copy.busy, languageCode: deps.copy.languageCode, kind: .busy), group: "notice:\(captionSequence)")
    }

    // MARK: Speaking

    private func enqueue(_ line: SpokenLine, group: String) {
        guard turn != .ended else { return }
        for chunk in VoiceText.chunkForSpeech(line.text) {
            queue.append(QueuedLine(line: SpokenLine(text: chunk, languageCode: line.languageCode, kind: line.kind), group: group))
        }
        pump()
    }

    private func pump() {
        while current == nil, turn != .ended {
            guard !queue.isEmpty else {
                if turn == .speaking {
                    lastSpeechEndAt = deps.clock.now
                    speaking = nil
                    setTurn(afterSpeech())
                    restartRunIfCumulative()
                }
                return
            }
            let next = queue.removeFirst()
            let captionId = jarvisCaption(next)
            // Without speech output the reply is shown as captions only.
            guard deps.synthesizer.isSupported else { continue }
            let wasSpeaking = turn == .speaking
            current = CurrentLine(line: next.line, group: next.group, captionId: captionId)
            speakGeneration += 1
            let generation = speakGeneration
            speaking = next.line
            setTurn(.speaking)
            if !wasSpeaking { restartRunIfCumulative() }
            deps.synthesizer.speak(
                next.line.text,
                languageCode: next.line.languageCode,
                voiceIdentifier: voiceIdentifier(for: next.line.languageCode),
                rate: deps.settings.rate
            ) { [weak self] _ in
                self?.speechDone(generation)
            }
            return
        }
    }

    private func speechDone(_ generation: Int) {
        guard generation == speakGeneration, let done = current else { return }
        recentSpoken = Array(recentSpoken.suffix(1)) + [done.line.text]
        current = nil
        lastSpeechEndAt = deps.clock.now
        pump()
    }

    /// Stops speaking at once and forgets the queue (barge-in, end, a failure).
    private func stopSpeaking() {
        speakGeneration += 1
        queue = []
        if let done = current {
            recentSpoken = Array(recentSpoken.suffix(1)) + [done.line.text]
            current = nil
            lastSpeechEndAt = deps.clock.now
        }
        deps.synthesizer.cancel()
    }

    /// The user spoke (or typed) while JARVIS was speaking: stop at once, the turn is theirs.
    private func bargeIn() {
        let interrupted = current?.captionId
        stopSpeaking()
        // The rest of this reply isn't spoken (it stays on screen in the task).
        stream.muted = true
        markInterrupted(interrupted)
        lastGroup = nil
        counters.bargeIns += 1
        speaking = nil
        loudSince = nil
        setTurn(afterSpeech(userTurn: true))
    }

    /// Where the turn goes once JARVIS has nothing (more) to say.
    private func afterSpeech(userTurn: Bool = false) -> VoiceTurn {
        if turn == .ended || turn == .failed { return turn }
        if pending != nil { return retryTimer != nil ? .retrying : .submitting }
        guard let status = task?.status else { return .ready }
        if status == .awaitingApproval { return .awaitingApproval }
        if Self.isWorking(status), !(userTurn || stream.muted) { return .thinking }
        return .ready
    }

    private func voiceIdentifier(for languageCode: String) -> String? {
        deps.settings.voiceNames[AppLocale(recognitionIdentifier: languageCode)]
    }

    private func setTurn(_ next: VoiceTurn) {
        guard next != turn else { return }
        turn = next
        if next == .ready { armIdle() }
    }

    // MARK: Captions

    @discardableResult
    private func addCaption(_ caption: ConversationCaption) -> Int {
        captionSequence += 1
        let line = ConversationCaption(
            id: captionSequence,
            speaker: caption.speaker,
            text: caption.text,
            languageCode: caption.languageCode,
            kind: caption.kind,
            interrupted: false,
            typed: caption.typed,
            unsent: caption.unsent,
            assent: caption.assent,
            taskId: caption.taskId
        )
        lastGroup = nil
        captions.append(line)
        return line.id
    }

    /// JARVIS's sentences of one reply share a caption (appended as they are spoken).
    private func jarvisCaption(_ next: QueuedLine) -> Int {
        if let last = lastGroup, last.group == next.group,
           let index = captions.firstIndex(where: { $0.id == last.captionId }) {
            captions[index].text += " \(next.line.text)"
            return last.captionId
        }
        let id = addCaption(
            ConversationCaption(id: 0, speaker: .jarvis, text: next.line.text, languageCode: next.line.languageCode,
                                kind: next.line.kind, taskId: task?.id)
        )
        lastGroup = (next.group, id)
        return id
    }

    private func setCaptionTask(_ id: Int, taskId: String) {
        if let index = captions.firstIndex(where: { $0.id == id }) { captions[index].taskId = taskId }
    }

    private func markUnsent(_ id: Int) {
        if let index = captions.firstIndex(where: { $0.id == id }) { captions[index].unsent = true }
    }

    private func markInterrupted(_ id: Int?) {
        guard let id, let index = captions.firstIndex(where: { $0.id == id }) else { return }
        captions[index].interrupted = true
    }

    // MARK: Idle

    private func armIdle() {
        guard idleEndTimer == nil, mic == .on else { return }
        let endMs = deps.idleEndMs
        idleWarnTimer = deps.clock.schedule(after: max(0, endMs - deps.idleWarnBeforeMs)) { [weak self] in
            guard let self else { return }
            self.idleWarnTimer = nil
            guard self.turn == .ready else { return }
            self.notice = .idleWarning
            self.enqueue(
                SpokenLine(text: self.deps.copy.idleWarning, languageCode: self.deps.copy.languageCode, kind: .notice),
                group: "idle:\(self.captionSequence)"
            )
        }
        idleEndTimer = deps.clock.schedule(after: endMs) { [weak self] in
            guard let self else { return }
            self.idleEndTimer = nil
            if self.turn == .ready || self.turn == .speaking { self.end(.idle) }
        }
    }

    private func clearIdle() {
        idleWarnTimer?.cancel()
        idleEndTimer?.cancel()
        idleWarnTimer = nil
        idleEndTimer = nil
    }

    private func resetIdle() {
        clearIdle()
        if turn == .ready { armIdle() }
    }
}
