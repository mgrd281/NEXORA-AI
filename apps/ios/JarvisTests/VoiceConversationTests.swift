import Foundation
import Testing
@testable import Jarvis

// Test doubles of the speech seams (tests only): a recognizer whose runs the test drives, a
// synthesizer that finishes when told, and a clock that runs timers when advanced.

@MainActor
final class FakeRecognitionRun: ConversationRecognitionRun {
    private let onEvent: @MainActor @Sendable (RecognitionEvent) -> Void
    private(set) var finalized = false
    private(set) var aborted = false
    private(set) var ended = false

    init(onEvent: @escaping @MainActor @Sendable (RecognitionEvent) -> Void) {
        self.onEvent = onEvent
    }

    func finalize() { finalized = true }
    func abort() { aborted = true }

    func send(_ event: RecognitionEvent) {
        onEvent(event)
    }

    func end() {
        ended = true
        onEvent(.ended)
    }
}

@MainActor
final class FakeRecognizer: ConversationRecognizer {
    var isSupported = true
    var isCumulative = false
    var allowsLevelBargeIn = false
    private(set) var runs: [FakeRecognitionRun] = []
    private(set) var locales: [String] = []

    var current: FakeRecognitionRun? { runs.last { !$0.aborted && !$0.ended } }

    func start(
        localeIdentifier: String,
        onEvent: @escaping @MainActor @Sendable (RecognitionEvent) -> Void
    ) throws -> any ConversationRecognitionRun {
        let run = FakeRecognitionRun(onEvent: onEvent)
        runs.append(run)
        locales.append(localeIdentifier)
        return run
    }

    /// The still-changing text of the current run.
    func hear(_ text: String) {
        current?.send(.result(finals: [], interim: text))
    }

    /// The recognizer's final result.
    func final(_ text: String) {
        current?.send(.result(finals: [text], interim: ""))
    }
}

@MainActor
final class FakeSynthesizer: ConversationSynthesizer {
    var isSupported = true
    private(set) var spoken: [String] = []
    private(set) var languages: [String] = []
    private(set) var cancels = 0
    private var pending: (@MainActor @Sendable (Bool) -> Void)?

    var isSpeaking: Bool { pending != nil }

    func speak(
        _ text: String,
        languageCode: String,
        voiceIdentifier: String?,
        rate: Double,
        onFinish: @escaping @MainActor @Sendable (Bool) -> Void
    ) {
        spoken.append(text)
        languages.append(languageCode)
        pending = onFinish
    }

    func cancel() {
        cancels += 1
        pending = nil
    }

    /// The current chunk was spoken to the end.
    func finish() {
        let done = pending
        pending = nil
        done?(true)
    }
}

@MainActor
final class ManualTimer: ConversationTimer {
    private(set) var cancelled = false
    func cancel() { cancelled = true }
}

@MainActor
final class ManualClock: ConversationClock {
    private struct Entry {
        let due: TimeInterval
        let order: Int
        let timer: ManualTimer
        let action: @MainActor @Sendable () -> Void
    }

    private(set) var now: TimeInterval = 0
    private var entries: [Entry] = []
    private var sequence = 0

    func schedule(after milliseconds: Int, _ action: @escaping @MainActor @Sendable () -> Void) -> any ConversationTimer {
        let timer = ManualTimer()
        sequence += 1
        entries.append(Entry(due: now + Double(milliseconds) / 1_000, order: sequence, timer: timer, action: action))
        return timer
    }

    /// Runs every timer due within `milliseconds`, in order.
    func advance(_ milliseconds: Int) {
        let target = now + Double(milliseconds) / 1_000
        while let next = entries
            .filter({ !$0.timer.cancelled && $0.due <= target + 0.000_001 })
            .min(by: { ($0.due, $0.order) < ($1.due, $1.order) }) {
            entries.removeAll { $0.timer === next.timer }
            now = max(now, next.due)
            next.action()
        }
        now = target
    }
}

/// What the controller asked the server to do, and what the server answers.
@MainActor
final class SubmitLog {
    var requests: [ConversationSubmitRequest] = []
    /// Errors thrown by the next submissions, in order (then they succeed).
    var failures: [any Error] = []
    var drafts: [String] = []
    var ended: [ConversationEnd] = []
}

@MainActor
struct ConversationHarness {
    let recognizer: FakeRecognizer
    let synthesizer: FakeSynthesizer
    let clock: ManualClock
    let log: SubmitLog
    let controller: VoiceConversationController

    init(language: AppLocale = .en, access: MicAccess = .granted, conversationId: String? = nil, cumulative: Bool = false) {
        let recognizer = FakeRecognizer()
        let synthesizer = FakeSynthesizer()
        let clock = ManualClock()
        let log = SubmitLog()
        recognizer.isCumulative = cumulative
        let locale = RecognitionLocale.auto.resolvedIdentifier(appLocale: language)
        let keyBox = KeyCounter()
        let dependencies = VoiceConversationController.Dependencies(
            recognizer: recognizer,
            synthesizer: synthesizer,
            clock: clock,
            requestAccess: { access },
            submit: { request in
                log.requests.append(request)
                if !log.failures.isEmpty { throw log.failures.removeFirst() }
                return ConversationSubmittedTask(id: "task-\(log.requests.count)", conversationId: "conv-1", status: .queued)
            },
            classify: { VoiceConversationModel.classify($0) },
            describe: { _ in "ERROR" },
            newKey: { keyBox.next() },
            copy: ConversationCopy(
                languageCode: "en-US",
                approvalOnScreen: "APPROVAL",
                busy: "BUSY",
                idleWarning: "IDLE",
                noMicrophone: "NOMIC",
                languageUnsupported: "NOLANG"
            ),
            settings: ConversationSettings(
                recognitionLocale: locale,
                language: language,
                silenceMs: 1_200,
                rate: 1,
                voiceNames: .defaults
            )
        )
        let controller = VoiceConversationController(dependencies: dependencies, conversationId: conversationId)
        controller.onDraft = { text in log.drafts.append(text) }
        controller.onEnded = { end in log.ended.append(end) }
        self.recognizer = recognizer
        self.synthesizer = synthesizer
        self.clock = clock
        self.log = log
        self.controller = controller
    }

    /// Says one utterance: what is heard, the silence, then the final result.
    func say(_ text: String) {
        recognizer.hear(text)
        clock.advance(1_200)
        recognizer.final(text)
    }

    func view(
        _ id: String = "task-1",
        status: TaskStatus,
        answer: String? = nil,
        line: SpokenLine? = nil,
        approvalId: String? = nil
    ) -> ConversationTaskView {
        ConversationTaskView(
            id: id,
            status: status,
            conversationId: "conv-1",
            answer: answer,
            answerLanguage: "en-US",
            line: line,
            approvalId: approvalId
        )
    }
}

@MainActor
final class KeyCounter {
    private var value = 0
    func next() -> String {
        value += 1
        return "key-\(value)"
    }
}

@Suite("Voice conversation: text rules")
struct VoiceTextTests {
    @Test("Normalisation drops case, punctuation and diacritics")
    func normalize() {
        #expect(VoiceText.normalize("  Stopp! ") == "stopp")
        #expect(VoiceText.normalize("Aufhören.") == "aufhoren")
        #expect(VoiceText.normalize("أنهِ المحادثة.") == VoiceText.normalize("انه المحادثه"))
        #expect(VoiceText.normalize("Hello,   world") == "hello world")
    }

    @Test("Stop phrases are whole utterances in the recognition language")
    func stopPhrases() {
        #expect(VoiceText.isStopPhrase("Stop.", locale: .en))
        #expect(VoiceText.isStopPhrase("Goodbye, JARVIS!", locale: .en))
        #expect(VoiceText.isStopPhrase("Stopp!", locale: .de))
        #expect(VoiceText.isStopPhrase("Gespräch beenden", locale: .de))
        #expect(VoiceText.isStopPhrase("توقّف", locale: .ar))
        #expect(VoiceText.isStopPhrase("إنهاء المحادثة.", locale: .ar))
        #expect(!VoiceText.isStopPhrase("stop the timer", locale: .en))
        #expect(!VoiceText.isStopPhrase("", locale: .en))
        // Every contract stop phrase is recognised as itself.
        for (locale, phrases) in VoiceLimits.stopPhrases {
            for phrase in phrases {
                #expect(VoiceText.isStopPhrase(phrase, locale: locale), "\(phrase)")
            }
        }
    }

    @Test("Assent is only assent words — and it is never an approval")
    func assent() {
        #expect(VoiceText.isAffirmation("Yes, approve it.", locale: .en))
        #expect(VoiceText.isAffirmation("Ja, genehmigen", locale: .de))
        #expect(VoiceText.isAffirmation("نعم موافق", locale: .ar))
        #expect(!VoiceText.isAffirmation("yes and email it to Bob", locale: .en))
    }

    @Test("The echo guard recognises JARVIS's own words")
    func echo() {
        let spoken = ["The weather in Berlin is sunny today."]
        #expect(VoiceText.isEcho("weather in Berlin", spoken: spoken))
        #expect(!VoiceText.isEcho("wait, what about Hamburg", spoken: spoken))
        #expect(VoiceText.removingEchoPrefix("in Berlin is sunny wait what about Hamburg", spoken: spoken) == "wait what about Hamburg")
        #expect(VoiceText.removingEchoPrefix("what about Hamburg", spoken: spoken) == "what about Hamburg")
    }

    @Test("A growing answer is spoken sentence by sentence")
    func sentences() {
        let first = VoiceText.takeSentences("It is sunny. Take a", from: 0, final: false, languageCode: "en-US")
        #expect(first.sentences == ["It is sunny."])
        let rest = VoiceText.takeSentences("It is sunny. Take a hat.", from: first.next, final: true, languageCode: "en-US")
        #expect(rest.sentences == ["Take a hat."])
        #expect(rest.next == "It is sunny. Take a hat.".utf16.count)
        #expect(VoiceText.takeSentences("Only one", from: 0, final: false, languageCode: "en-US").sentences.isEmpty)
    }

    @Test("Long sentences are split at commas, then words")
    func chunks() {
        let sentence = Array(repeating: "word", count: 40).joined(separator: " ") + ", " + Array(repeating: "more", count: 40).joined(separator: " ")
        let chunks = VoiceText.chunkForSpeech(sentence, max: 120)
        #expect(chunks.allSatisfy { $0.count <= 120 })
        #expect(chunks.joined(separator: " ").split(separator: " ").count == 80)
        #expect(VoiceText.chunkForSpeech("Short.") == ["Short."])
        #expect(VoiceText.chunkForSpeech("   ").isEmpty)
    }

    @Test("Spoken text has no bidi isolation marks")
    func plain() {
        #expect(VoiceText.plain("Call \u{2068}Dr. Weber\u{2069}  now") == "Call Dr. Weber now")
    }
}

@Suite("Voice conversation: state machine")
@MainActor
struct VoiceConversationControllerTests {
    @Test("Listen → end of utterance → submit → speak the streamed answer → listen again")
    func happyPath() async {
        let h = ConversationHarness()
        await h.controller.start()
        #expect(h.controller.mic == .on)
        #expect(h.controller.turn == .ready)

        h.recognizer.hear("what's the weather")
        #expect(h.controller.interim == "what's the weather")
        h.clock.advance(1_199)
        #expect(h.recognizer.runs[0].finalized == false)
        h.clock.advance(1)
        // The silence asks the recognizer for its final result; nothing is sent before it.
        #expect(h.recognizer.runs[0].finalized)
        #expect(h.log.requests.isEmpty)
        h.recognizer.final("What's the weather?")
        await h.controller.inFlight?.value

        #expect(h.log.requests.count == 1)
        #expect(h.log.requests[0].text == "What's the weather?")
        #expect(h.log.requests[0].source == .voice)
        #expect(h.log.requests[0].conversationId == nil)
        #expect(h.controller.turn == .thinking)
        #expect(h.controller.taskId == "task-1")

        h.controller.answerDelta(taskId: "task-1", text: "It is sunny. ")
        #expect(h.synthesizer.spoken.isEmpty)
        h.controller.answerDelta(taskId: "task-1", text: "Take a hat.")
        #expect(h.synthesizer.spoken == ["It is sunny."])
        #expect(h.controller.turn == .speaking)

        h.controller.updateTask(h.view(status: .completed, answer: "It is sunny. Take a hat."))
        h.synthesizer.finish()
        #expect(h.synthesizer.spoken == ["It is sunny.", "Take a hat."])
        h.synthesizer.finish()
        #expect(h.controller.turn == .ready)
        #expect(h.controller.speaking == nil)
        #expect(h.controller.counters.turns == 1)
        let jarvis = h.controller.captions.filter { $0.speaker == .jarvis }
        #expect(jarvis.map(\.text) == ["It is sunny. Take a hat."])

        // The next utterance is a follow-up in the same conversation, with a new key.
        h.say("And tomorrow?")
        await h.controller.inFlight?.value
        #expect(h.log.requests.count == 2)
        #expect(h.log.requests[1].conversationId == "conv-1")
        #expect(h.log.requests[1].idempotencyKey != h.log.requests[0].idempotencyKey)
    }

    @Test("A reply without an answer speaks the task's own line")
    func resultLine() async {
        let h = ConversationHarness()
        await h.controller.start()
        h.say("Email the summary to me")
        await h.controller.inFlight?.value
        h.controller.updateTask(h.view(status: .completed, line: SpokenLine(text: "Sent the email.", languageCode: "en-US", kind: .result)))
        #expect(h.synthesizer.spoken == ["Sent the email."])
    }

    @Test("Barge-in: the user's words stop JARVIS at once; its own echo doesn't")
    func bargeIn() async {
        let h = ConversationHarness()
        await h.controller.start()
        h.say("Tell me a story")
        await h.controller.inFlight?.value
        h.controller.updateTask(h.view(status: .completed, answer: "Once upon a time there was a fox. It lived in a forest."))
        #expect(h.controller.turn == .speaking)

        h.recognizer.hear("once upon a time")
        #expect(h.synthesizer.cancels == 0)
        #expect(h.controller.turn == .speaking)

        h.recognizer.hear("wait, a different one")
        #expect(h.synthesizer.cancels == 1)
        #expect(h.controller.counters.bargeIns == 1)
        #expect(h.controller.turn == .ready)
        #expect(h.controller.captions.last { $0.speaker == .jarvis }?.interrupted == true)
        // The rest of the interrupted reply isn't spoken.
        h.synthesizer.finish()
        #expect(h.synthesizer.spoken.count == 1)
    }

    @Test("Barge-in by loudness only when the voice can't reach the microphone")
    func levelBargeIn() async {
        let h = ConversationHarness()
        await h.controller.start()
        h.say("Read it")
        await h.controller.inFlight?.value
        h.controller.updateTask(h.view(status: .completed, answer: "A long answer."))
        h.recognizer.current?.send(.level(0.9))
        h.clock.advance(400)
        h.recognizer.current?.send(.level(0.9))
        #expect(h.synthesizer.cancels == 0)

        h.recognizer.allowsLevelBargeIn = true
        h.recognizer.current?.send(.level(0.9))
        h.clock.advance(350)
        h.recognizer.current?.send(.level(0.9))
        #expect(h.synthesizer.cancels == 1)
        #expect(h.controller.counters.bargeIns == 1)
    }

    @Test("Approvals are never given by voice: JARVIS says so, and \"yes\" is not a decision")
    func approvals() async {
        let h = ConversationHarness()
        await h.controller.start()
        h.say("Call the dentist at +49 30 123456700")
        await h.controller.inFlight?.value
        h.controller.updateTask(h.view(status: .awaitingApproval, approvalId: "approval-1"))
        #expect(h.synthesizer.spoken == ["APPROVAL"])
        #expect(h.controller.notice == .approvalOnScreen)
        #expect(h.controller.approvalId == "approval-1")
        h.synthesizer.finish()
        #expect(h.controller.turn == .awaitingApproval)

        h.say("Yes, approve it")
        #expect(h.log.requests.count == 1)
        #expect(h.controller.captions.last?.assent == true)
        #expect(h.log.drafts.isEmpty)
        #expect(h.synthesizer.spoken.last == "APPROVAL")
        h.synthesizer.finish()

        h.say("Call my sister instead")
        #expect(h.log.requests.count == 1)
        #expect(h.log.drafts == ["Call my sister instead"])
        h.synthesizer.finish()
        #expect(h.controller.turn == .awaitingApproval)

        // Approved on screen: the task works again.
        h.controller.updateTask(h.view(status: .running))
        #expect(h.controller.turn == .thinking)
    }

    @Test("While a task works, a new utterance isn't queued silently")
    func busy() async {
        let h = ConversationHarness()
        await h.controller.start()
        h.say("Summarize example.org")
        await h.controller.inFlight?.value
        h.controller.updateTask(h.view(status: .running))
        h.say("And email it")
        #expect(h.log.requests.count == 1)
        #expect(h.log.drafts == ["And email it"])
        #expect(h.synthesizer.spoken == ["BUSY"])
        #expect(h.controller.captions.last { $0.speaker == .user }?.unsent == true)
    }

    @Test("A stop phrase ends voice mode, never the task, and is never sent")
    func stopPhrase() async {
        let h = ConversationHarness(language: .de)
        await h.controller.start()
        #expect(h.recognizer.locales == ["de-DE"])
        h.say("Stopp!")
        #expect(h.log.requests.isEmpty)
        #expect(h.controller.turn == .ended)
        #expect(h.controller.mic == .off)
        #expect(h.log.ended.map(\.reason) == [.voiceCommand])
        #expect(h.recognizer.runs.allSatisfy { $0.aborted || $0.ended })
    }

    @Test("A lost request is retried with the same key, then sent once")
    func networkRetry() async {
        let h = ConversationHarness()
        h.log.failures = [NetworkError.offline, NetworkError.timedOut]
        await h.controller.start()
        h.say("Remind me to call Anna")
        await h.controller.inFlight?.value
        #expect(h.controller.turn == .retrying)
        #expect(h.controller.submitError == "ERROR")
        h.clock.advance(VoiceLimits.reconnectDelaysMs[0])
        await h.controller.inFlight?.value
        #expect(h.controller.turn == .retrying)
        h.clock.advance(VoiceLimits.reconnectDelaysMs[1])
        await h.controller.inFlight?.value
        #expect(h.controller.turn == .thinking)
        #expect(h.log.requests.count == 3)
        #expect(Set(h.log.requests.map(\.idempotencyKey)).count == 1)
        #expect(h.controller.counters.reconnects == 2)
        #expect(h.controller.counters.turns == 1)
    }

    @Test("After the last retry the session stops listening and keeps the words")
    func networkExhausted() async {
        let h = ConversationHarness()
        h.log.failures = Array(repeating: NetworkError.offline, count: VoiceLimits.reconnectDelaysMs.count + 1)
        await h.controller.start()
        h.say("Book a table")
        await h.controller.inFlight?.value
        for delay in VoiceLimits.reconnectDelaysMs {
            h.clock.advance(delay)
            await h.controller.inFlight?.value
        }
        #expect(h.controller.turn == .failed)
        #expect(h.controller.mic == .off)
        #expect(h.log.drafts == ["Book a table"])
        #expect(h.controller.captions.last?.unsent == true)
    }

    @Test("A refused request is shown and the conversation goes on")
    func refusedRequest() async {
        let h = ConversationHarness()
        h.log.failures = [ApiError(code: .validationFailed, message: "bad", httpStatus: 400)]
        await h.controller.start()
        h.say("Do something")
        await h.controller.inFlight?.value
        #expect(h.controller.turn == .ready)
        #expect(h.controller.submitError == "ERROR")
        #expect(h.log.drafts == ["Do something"])
        #expect(h.log.requests.count == 1)
    }

    @Test("CONVERSATION_BUSY from the server is said, and the words stay in the text field")
    func serverBusy() async {
        let h = ConversationHarness()
        h.log.failures = [ApiError(code: .conflict, message: "busy", httpStatus: 409, details: ["reason": .string("CONVERSATION_BUSY")])]
        await h.controller.start()
        h.say("Next one")
        await h.controller.inFlight?.value
        #expect(h.synthesizer.spoken == ["BUSY"])
        #expect(h.log.drafts == ["Next one"])
    }

    @Test("Recognition restarts after errors with the contract's delays, then gives up")
    func recognitionRecovery() async {
        let h = ConversationHarness()
        await h.controller.start()
        for (index, delay) in VoiceLimits.reconnectDelaysMs.enumerated() {
            h.recognizer.current?.send(.failed(.other("network")))
            #expect(h.controller.mic == .starting)
            h.clock.advance(delay)
            #expect(h.recognizer.runs.count == index + 2)
            #expect(h.controller.mic == .on)
        }
        h.recognizer.current?.send(.failed(.other("network")))
        #expect(h.controller.mic == .failed)
        #expect(h.controller.counters.reconnects == VoiceLimits.reconnectDelaysMs.count)
    }

    @Test("Nothing said in a run just starts the next one")
    func noSpeech() async {
        let h = ConversationHarness()
        await h.controller.start()
        h.clock.advance(5_000)
        h.recognizer.current?.send(.failed(.noSpeech))
        h.recognizer.current?.end()
        #expect(h.recognizer.runs.count == 2)
        #expect(h.controller.mic == .on)
        #expect(h.controller.counters.reconnects == 0)
        // A run that ends at once backs off instead of restarting in a loop.
        h.recognizer.current?.end()
        #expect(h.recognizer.runs.count == 2)
        #expect(h.controller.mic == .starting)
        #expect(h.controller.counters.reconnects == 1)
        h.clock.advance(VoiceLimits.reconnectDelaysMs[0])
        #expect(h.recognizer.runs.count == 3)
    }

    @Test("Denied permissions say which one, and typing still works")
    func denied() async {
        let h = ConversationHarness(access: .deniedMicrophone)
        await h.controller.start()
        #expect(h.controller.mic == .denied(.microphone))
        #expect(h.recognizer.runs.isEmpty)
        #expect(h.controller.submitText("Typed request"))
        await h.controller.inFlight?.value
        #expect(h.log.requests.first?.source == .text)
    }

    @Test("An idle conversation is announced, then ends by itself")
    func idle() async {
        let h = ConversationHarness()
        await h.controller.start()
        h.clock.advance(VoiceLimits.idleEndSeconds * 1_000 - 10_000)
        #expect(h.controller.notice == .idleWarning)
        #expect(h.synthesizer.spoken == ["IDLE"])
        h.synthesizer.finish()
        h.clock.advance(10_000)
        #expect(h.controller.turn == .ended)
        #expect(h.log.ended.first?.reason == .idle)
    }

    @Test("An interruption stops everything; what was heard goes to the text field")
    func interruption() async {
        let h = ConversationHarness()
        await h.controller.start()
        h.recognizer.hear("send the report to")
        h.controller.interrupt()
        #expect(h.controller.mic == .muted)
        #expect(h.controller.notice == .interrupted)
        #expect(h.log.drafts == ["send the report to"])
        #expect(h.recognizer.runs[0].aborted)
        h.clock.advance(5_000)
        #expect(h.log.requests.isEmpty)

        await h.controller.interruptionEnded(shouldResume: true)
        #expect(h.controller.mic == .on)
        #expect(h.recognizer.runs.count == 2)
    }

    @Test("Muting with words heard ends the utterance now")
    func pauseSends() async {
        let h = ConversationHarness()
        await h.controller.start()
        h.recognizer.hear("what time is it")
        h.controller.pause()
        await h.controller.inFlight?.value
        #expect(h.controller.mic == .muted)
        #expect(h.log.requests.map(\.text) == ["what time is it"])
    }

    @Test("Cumulative recognition starts a fresh run around JARVIS's speech")
    func cumulativeRuns() async {
        let h = ConversationHarness(cumulative: true)
        await h.controller.start()
        h.say("Tell me a joke")
        await h.controller.inFlight?.value
        let before = h.recognizer.runs.count
        h.controller.updateTask(h.view(status: .completed, answer: "Why did the chicken cross the road?"))
        #expect(h.recognizer.runs.count == before + 1)
        // The user talks over it: what they said is kept, and listening starts afresh.
        h.recognizer.hear("why did the chicken no wait tell me another")
        #expect(h.synthesizer.cancels == 1)
        #expect(h.controller.heard == "no wait tell me another")
        #expect(h.recognizer.runs.count == before + 2)
        h.clock.advance(1_200)
        await h.controller.inFlight?.value
        #expect(h.log.requests.last?.text == "no wait tell me another")
    }

    @Test("Ending records the counters once and stops speaking")
    func ending() async {
        let h = ConversationHarness()
        await h.controller.start()
        h.say("Hello")
        await h.controller.inFlight?.value
        h.controller.updateTask(h.view(status: .completed, answer: "Hi there."))
        h.controller.end(.endButton)
        h.controller.end(.escapeKey)
        #expect(h.log.ended.count == 1)
        #expect(h.log.ended[0].reason == .endButton)
        #expect(h.log.ended[0].counters.turns == 1)
        #expect(h.synthesizer.cancels >= 1)
        #expect(!h.controller.submitText("after the end"))
    }

    @Test("The voice-session outcome is metadata of what happened")
    func outcome() {
        let counters = VoiceSessionCounters(turns: 2, bargeIns: 1, reconnects: 0, chars: 40)
        #expect(VoiceConversationModel.outcome(of: ConversationEnd(reason: .voiceCommand, counters: counters, errorCode: nil), heardSomething: true) == .ended)
        #expect(VoiceConversationModel.outcome(of: ConversationEnd(reason: .error, counters: VoiceSessionCounters(), errorCode: "x"), heardSomething: false) == .error)
        #expect(VoiceConversationModel.outcome(of: ConversationEnd(reason: .endButton, counters: VoiceSessionCounters(), errorCode: nil), heardSomething: false) == .noSpeech)
        #expect(VoiceConversationModel.outcome(of: ConversationEnd(reason: .endButton, counters: VoiceSessionCounters(), errorCode: nil), heardSomething: true) == .cancelled)
    }

    @Test("Submit failures: busy, retried or shown")
    func classify() {
        #expect(VoiceConversationModel.classify(NetworkError.offline) == .network)
        #expect(VoiceConversationModel.classify(NetworkError.invalidResponse("x")) == .fatal)
        #expect(VoiceConversationModel.classify(ApiError(code: .conflict, message: "", httpStatus: 409, details: ["reason": .string("CONVERSATION_BUSY")])) == .busy)
        #expect(VoiceConversationModel.classify(ApiError(code: .conflict, message: "in progress", httpStatus: 409)) == .network)
        #expect(VoiceConversationModel.classify(ApiError(code: .rateLimited, message: "", httpStatus: 429)) == .network)
        #expect(VoiceConversationModel.classify(ApiError(code: .internalError, message: "", httpStatus: 503)) == .network)
        #expect(VoiceConversationModel.classify(ApiError(code: .validationFailed, message: "", httpStatus: 400)) == .fatal)
    }
}
