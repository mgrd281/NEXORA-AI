import AVFoundation
import Foundation
import Speech

// The live speech seams of voice conversation mode: SFSpeechRecognizer on an AVAudioEngine input
// tap (on the device when the recognizer supports it), AVSpeechSynthesizer for JARVIS's voice,
// one shared audio session configured for talking over each other, and the system's
// interruptions and route changes. Audio never leaves the device through JARVIS.

/// The shared audio session of a conversation: play and record at once, voice-chat mode (the
/// system's voice processing), other audio ducked, the loudspeaker by default (not the
/// earpiece), Bluetooth headsets allowed.
enum ConversationAudioSession {
    /// Configures and activates the session (idempotent).
    static func activate() throws {
        let session = AVAudioSession.sharedInstance()
        // `.allowBluetooth` (HFP) keeps building with the iOS 18 SDK; newer SDKs call it
        // `.allowBluetoothHFP`.
        let options: AVAudioSession.CategoryOptions = [.duckOthers, .defaultToSpeaker, .allowBluetooth]
        if session.category != .playAndRecord || session.mode != .voiceChat || session.categoryOptions != options {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
        }
        try session.setActive(true, options: [])
    }

    /// Releases the session so other apps' audio returns to full volume.
    static func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// JARVIS's voice can't reach the microphone (headphones or a Bluetooth headset).
    static var usesHeadphones: Bool {
        let headphonePorts: Set<AVAudioSession.Port> = [.headphones, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE]
        return AVAudioSession.sharedInstance().currentRoute.outputs.contains { headphonePorts.contains($0.portType) }
    }
}

/// Holds the current recognition request for the real-time audio tap. Only thread-safe operations
/// happen through it (`append` is designed to be fed from the tap).
private final class RecognitionRequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?

    func set(_ value: SFSpeechAudioBufferRecognitionRequest?) {
        lock.lock()
        request = value
        lock.unlock()
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let current = request
        lock.unlock()
        current?.append(buffer)
    }

    /// Ends the audio of the current request; the tap feeds nothing until the next run.
    func endAudio() {
        lock.lock()
        let current = request
        request = nil
        lock.unlock()
        current?.endAudio()
    }
}

/// The microphone and the recognition runs.
///
/// Deliberately not actor-isolated (like `SpeechSession`): the tap runs on a real-time audio
/// thread and the recognizer calls back on its own queue, and closures formed in a `@MainActor`
/// context would trip Swift 6's runtime isolation check there. Methods are called from the main
/// actor only; callbacks touch only the thread-safe continuation and the request box.
final class ConversationAudioEngine: @unchecked Sendable {
    enum Output: Sendable {
        case level(Double)
        case result(run: Int, text: String, isFinal: Bool)
        case failed(run: Int, domain: String, code: Int)
        case ended(run: Int)
    }

    let outputs: AsyncStream<Output>
    private let continuation: AsyncStream<Output>.Continuation
    private let engine = AVAudioEngine()
    private let box = RecognitionRequestBox()
    private var tapInstalled = false
    private var task: SFSpeechRecognitionTask?
    private var currentRun = 0
    private var recognizers: [String: SFSpeechRecognizer] = [:]

    init() {
        let pair = AsyncStream.makeStream(of: Output.self, bufferingPolicy: .bufferingNewest(512))
        outputs = pair.stream
        continuation = pair.continuation
    }

    var isRunning: Bool { engine.isRunning }

    /// Configures the session and starts the microphone tap (before the first run).
    func startAudio() throws {
        guard !engine.isRunning else { return }
        do {
            try ConversationAudioSession.activate()
        } catch {
            throw RecognitionFailure.audioUnavailable
        }
        let input = engine.inputNode
        if tapInstalled {
            input.removeTap(onBus: 0)
            tapInstalled = false
        }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw RecognitionFailure.audioUnavailable }
        let box = self.box
        let continuation = self.continuation
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            box.append(buffer)
            continuation.yield(.level(SpeechSession.level(of: buffer)))
        }
        tapInstalled = true
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            tapInstalled = false
            throw RecognitionFailure.audioUnavailable
        }
    }

    /// Stops the microphone (the session stays as it is; see `ConversationAudioSession`).
    func stopAudio() {
        cancelTask()
        if engine.isRunning { engine.stop() }
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
    }

    /// Starts a recognition run; returns its id and whether it runs on the device.
    func startRun(localeIdentifier: String) throws -> (run: Int, onDevice: Bool) {
        let recognizer = try recognizer(for: localeIdentifier)
        cancelTask()
        currentRun += 1
        let run = currentRun
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        request.addsPunctuation = true
        request.taskHint = .dictation
        box.set(request)
        let continuation = self.continuation
        task = recognizer.recognitionTask(with: request) { result, error in
            if let result {
                continuation.yield(.result(run: run, text: result.bestTranscription.formattedString, isFinal: result.isFinal))
                if result.isFinal {
                    continuation.yield(.ended(run: run))
                    return
                }
            }
            if let error {
                let nsError = error as NSError
                continuation.yield(.failed(run: run, domain: nsError.domain, code: nsError.code))
                continuation.yield(.ended(run: run))
            }
        }
        return (run, request.requiresOnDeviceRecognition)
    }

    /// Ends the audio of a run: the recognizer then delivers its final result.
    func finalizeRun(_ run: Int) {
        guard run == currentRun else { return }
        box.endAudio()
    }

    /// Ends a run at once (its late callbacks carry its old id and are ignored).
    func abortRun(_ run: Int) {
        guard run == currentRun else { return }
        cancelTask()
    }

    /// Stops everything; no more outputs.
    func shutdown() {
        stopAudio()
        continuation.finish()
    }

    private func cancelTask() {
        box.set(nil)
        task?.cancel()
        task = nil
    }

    private func recognizer(for identifier: String) throws -> SFSpeechRecognizer {
        if let cached = recognizers[identifier], cached.isAvailable { return cached }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: identifier)) else {
            throw RecognitionFailure.languageUnsupported
        }
        guard recognizer.isAvailable else { throw RecognitionFailure.other("recognizer-unavailable") }
        recognizers[identifier] = recognizer
        return recognizer
    }

    /// The speech framework's "no speech detected" (kAFAssistantErrorDomain 1110) just restarts
    /// the run; everything else is retried by the controller with backoff, then shown.
    static func failure(domain: String, code: Int) -> RecognitionFailure {
        if domain == "kAFAssistantErrorDomain", code == 1110 { return .noSpeech }
        return .other("\(domain):\(code)")
    }
}

/// One recognition run of the live recognizer.
@MainActor
final class LiveRecognitionRun: ConversationRecognitionRun {
    let id: Int
    private weak var owner: LiveConversationRecognizer?
    private let onEvent: @MainActor @Sendable (RecognitionEvent) -> Void
    private var isDone = false

    init(id: Int, owner: LiveConversationRecognizer, onEvent: @escaping @MainActor @Sendable (RecognitionEvent) -> Void) {
        self.id = id
        self.owner = owner
        self.onEvent = onEvent
    }

    func emit(_ event: RecognitionEvent) {
        guard !isDone else { return }
        if event == .ended { isDone = true }
        onEvent(event)
    }

    func finalize() {
        owner?.finalize(id)
    }

    func abort() {
        isDone = true
        owner?.abort(id)
    }
}

/// `ConversationRecognizer` on SFSpeechRecognizer: a run's text is everything heard since it
/// started (cumulative), and it reports the microphone level for Presence.
@MainActor
final class LiveConversationRecognizer: ConversationRecognizer {
    let isSupported = true
    let isCumulative = true
    private(set) var allowsLevelBargeIn = ConversationAudioSession.usesHeadphones
    /// The last run was recognised on this iPhone (else by Apple's speech service).
    private(set) var isOnDevice = true

    /// An audio interruption began (`true`) or ended (`false`, with whether to resume).
    var onInterruption: (@MainActor (Bool, Bool) -> Void)?
    /// Headphones were unplugged (speaking must stop).
    var onOutputRouteLost: (@MainActor () -> Void)?

    private let audio = ConversationAudioEngine()
    private var consumer: Task<Void, Never>?
    private var runs: [Int: LiveRecognitionRun] = [:]
    private var currentRun: Int?
    private var observers: [any NSObjectProtocol] = []
    private var isShutDown = false

    init() {
        let outputs = audio.outputs
        consumer = Task { [weak self] in
            for await output in outputs {
                self?.handle(output)
            }
        }
        observeAudioSession()
    }

    func start(
        localeIdentifier: String,
        onEvent: @escaping @MainActor @Sendable (RecognitionEvent) -> Void
    ) throws -> any ConversationRecognitionRun {
        guard !isShutDown else { throw RecognitionFailure.audioUnavailable }
        try audio.startAudio()
        allowsLevelBargeIn = ConversationAudioSession.usesHeadphones
        let started = try audio.startRun(localeIdentifier: localeIdentifier)
        isOnDevice = started.onDevice
        let run = LiveRecognitionRun(id: started.run, owner: self, onEvent: onEvent)
        runs = [started.run: run]
        currentRun = started.run
        return run
    }

    fileprivate func finalize(_ id: Int) {
        audio.finalizeRun(id)
    }

    fileprivate func abort(_ id: Int) {
        runs[id] = nil
        audio.abortRun(id)
    }

    /// Stops the microphone and releases the audio session (the conversation ended).
    func shutdown() {
        guard !isShutDown else { return }
        isShutDown = true
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        runs = [:]
        currentRun = nil
        audio.shutdown()
        consumer?.cancel()
        consumer = nil
        ConversationAudioSession.deactivate()
    }

    private func handle(_ output: ConversationAudioEngine.Output) {
        switch output {
        case .level(let value):
            if let id = currentRun, let run = runs[id] { run.emit(.level(value)) }
        case .result(let id, let text, let isFinal):
            guard let run = runs[id] else { return }
            run.emit(isFinal ? .result(finals: [text], interim: "") : .result(finals: [], interim: text))
        case .failed(let id, let domain, let code):
            guard let run = runs[id] else { return }
            run.emit(.failed(ConversationAudioEngine.failure(domain: domain, code: code)))
        case .ended(let id):
            guard let run = runs.removeValue(forKey: id) else { return }
            run.emit(.ended)
        }
    }

    // MARK: The system's audio events

    private func observeAudioSession() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt)
                .flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt)
                .map(AVAudioSession.InterruptionOptions.init(rawValue:)) ?? []
            let began = type == .began
            let shouldResume = options.contains(.shouldResume)
            MainActor.assumeIsolated {
                self?.interruption(began: began, shouldResume: shouldResume)
            }
        })
        observers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt)
                .flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            let outputLost = reason == .oldDeviceUnavailable
            let deviceChanged = reason == .oldDeviceUnavailable || reason == .newDeviceAvailable
            MainActor.assumeIsolated {
                self?.routeChanged(outputLost: outputLost, deviceChanged: deviceChanged)
            }
        })
        observers.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.restartAudioAfterChange()
            }
        })
    }

    private func interruption(began: Bool, shouldResume: Bool) {
        guard !isShutDown else { return }
        if began {
            // The system stopped the microphone; the controller pauses and keeps what was heard.
            audio.stopAudio()
            runs = [:]
            currentRun = nil
        }
        onInterruption?(began, shouldResume)
    }

    private func routeChanged(outputLost: Bool, deviceChanged: Bool) {
        guard !isShutDown else { return }
        allowsLevelBargeIn = ConversationAudioSession.usesHeadphones
        if outputLost { onOutputRouteLost?() }
        if deviceChanged { restartAudioAfterChange() }
    }

    /// The input format may have changed: the current run ends with an error, which the
    /// controller answers by starting a new one (counted as a reconnect).
    private func restartAudioAfterChange() {
        guard !isShutDown, audio.isRunning else { return }
        audio.stopAudio()
        if let id = currentRun, let run = runs.removeValue(forKey: id) {
            run.emit(.failed(.other("audio-route-changed")))
            run.emit(.ended)
        }
        currentRun = nil
    }
}

/// `ConversationSynthesizer` on AVSpeechSynthesizer, in the conversation's audio session.
@MainActor
final class LiveConversationSynthesizer: ConversationSynthesizer {
    let isSupported = true
    private let synthesizer = AVSpeechSynthesizer()
    private let observer: SynthesisObserver
    private var consumer: Task<Void, Never>?
    private var pending: [ObjectIdentifier: PendingUtterance] = [:]
    /// Cancelled utterances kept until their callback arrives, so an identifier is never reused
    /// while one is in flight.
    private var retired: [ObjectIdentifier: AVSpeechUtterance] = [:]

    private struct PendingUtterance {
        let utterance: AVSpeechUtterance
        let onFinish: @MainActor @Sendable (Bool) -> Void
    }

    init() {
        let pair = AsyncStream.makeStream(of: SynthesisObserver.Event.self)
        observer = SynthesisObserver(continuation: pair.continuation)
        synthesizer.usesApplicationAudioSession = true
        synthesizer.delegate = observer
        let events = pair.stream
        consumer = Task { [weak self] in
            for await event in events {
                self?.handle(event)
            }
        }
    }

    func speak(
        _ text: String,
        languageCode: String,
        voiceIdentifier: String?,
        rate: Double,
        onFinish: @escaping @MainActor @Sendable (Bool) -> Void
    ) {
        try? ConversationAudioSession.activate()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.voice(identifier: voiceIdentifier, languageCode: languageCode)
        utterance.rate = Self.rate(rate)
        pending[ObjectIdentifier(utterance)] = PendingUtterance(utterance: utterance, onFinish: onFinish)
        synthesizer.speak(utterance)
    }

    func cancel() {
        for (id, entry) in pending { retired[id] = entry.utterance }
        pending = [:]
        if synthesizer.isSpeaking || synthesizer.isPaused {
            synthesizer.stopSpeaking(at: .immediate)
        }
    }

    func shutdown() {
        cancel()
        consumer?.cancel()
        consumer = nil
    }

    private func handle(_ event: SynthesisObserver.Event) {
        retired[event.utterance] = nil
        guard let entry = pending.removeValue(forKey: event.utterance) else { return }
        // A cancel the system made (not ours) still moves the conversation on.
        entry.onFinish(event.finished)
    }

    /// The chosen voice when this device has it, else the system's voice for the language.
    static func voice(identifier: String?, languageCode: String) -> AVSpeechSynthesisVoice? {
        if let identifier, let voice = AVSpeechSynthesisVoice(identifier: identifier) { return voice }
        return AVSpeechSynthesisVoice(language: languageCode)
    }

    /// The rate multiplier on AVSpeechSynthesizer's scale (default rate × multiplier).
    static func rate(_ multiplier: Double) -> Float {
        let value = AVSpeechUtteranceDefaultSpeechRate * Float(VoiceLimits.clampRate(multiplier))
        return min(AVSpeechUtteranceMaximumSpeechRate, max(AVSpeechUtteranceMinimumSpeechRate, value))
    }
}

/// Receives the synthesizer's callbacks (on its own queue) and hands them to the main actor.
private final class SynthesisObserver: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    struct Event: Sendable {
        let utterance: ObjectIdentifier
        let finished: Bool
    }

    private let continuation: AsyncStream<Event>.Continuation

    init(continuation: AsyncStream<Event>.Continuation) {
        self.continuation = continuation
        super.init()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        continuation.yield(Event(utterance: ObjectIdentifier(utterance), finished: true))
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        continuation.yield(Event(utterance: ObjectIdentifier(utterance), finished: false))
    }
}

/// Real timers on the main actor.
@MainActor
final class SystemConversationClock: ConversationClock {
    var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    func schedule(after milliseconds: Int, _ action: @escaping @MainActor @Sendable () -> Void) -> any ConversationTimer {
        let timer = ConversationTaskTimer()
        let delay = max(0, milliseconds)
        timer.task = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(delay))
            guard !Task.isCancelled else { return }
            action()
        }
        return timer
    }
}

@MainActor
final class ConversationTaskTimer: ConversationTimer {
    fileprivate var task: Task<Void, Never>?

    func cancel() {
        task?.cancel()
        task = nil
    }
}
