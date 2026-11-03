import AVFoundation
import Foundation
import Speech

/// Permission prompts for speech recognition and the microphone.
///
/// Deliberately not actor-isolated: the system calls these completion handlers on
/// background queues, and closures formed in a `@MainActor` context would trip Swift 6's
/// runtime isolation check there.
enum SpeechPermissions {
    static func requestSpeechRecognition() async -> SFSpeechRecognizerAuthorizationStatus {
        let current = SFSpeechRecognizer.authorizationStatus()
        guard current == .notDetermined else { return current }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    static func requestMicrophone() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        @unknown default:
            return false
        }
    }
}

/// Holds a non-Sendable reference for use from the audio tap, which runs on a
/// real-time audio thread. Only thread-safe operations are performed through it
/// (`SFSpeechAudioBufferRecognitionRequest.append` is designed to be fed from the tap).
private final class UncheckedReference<Value: AnyObject>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}

/// One dictation: microphone audio → `SFSpeechRecognizer`, with live input level.
///
/// Audio is processed on the device when the recognizer supports it
/// (`requiresOnDeviceRecognition`); otherwise Apple's speech service recognises it.
/// JARVIS itself never receives audio — only the final, user-confirmed text.
///
/// Threading: `start()`, `stop()` and `cancel()` are called from the main actor. The tap
/// and recognition callbacks touch only the `AsyncStream` continuation (thread-safe) and
/// the request reference. Hence `@unchecked Sendable`.
final class SpeechSession: @unchecked Sendable {
    enum Update: Sendable, Equatable {
        /// Input level, 0...1, roughly 40 times per second.
        case level(Double)
        case transcript(String, isFinal: Bool)
        case failed(domain: String, code: Int)
    }

    enum StartError: Error {
        case noAudioInput
    }

    let updates: AsyncStream<Update>
    let isOnDevice: Bool

    private let continuation: AsyncStream<Update>.Continuation
    private let recognizer: SFSpeechRecognizer
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var tapInstalled = false

    init(recognizer: SFSpeechRecognizer) {
        self.recognizer = recognizer
        self.isOnDevice = recognizer.supportsOnDeviceRecognition
        let pair = AsyncStream.makeStream(of: Update.self)
        updates = pair.stream
        continuation = pair.continuation
    }

    func start() throws {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = isOnDevice
        request.addsPunctuation = true
        request.taskHint = .dictation
        self.request = request

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            deactivateAudioSession()
            throw StartError.noAudioInput
        }

        let continuation = self.continuation
        let requestReference = UncheckedReference(request)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            requestReference.value.append(buffer)
            continuation.yield(.level(SpeechSession.level(of: buffer)))
        }
        tapInstalled = true

        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            tapInstalled = false
            deactivateAudioSession()
            throw error
        }

        recognitionTask = recognizer.recognitionTask(with: request) { result, error in
            if let result {
                let text = result.bestTranscription.formattedString
                continuation.yield(.transcript(text, isFinal: result.isFinal))
                if result.isFinal {
                    continuation.finish()
                    return
                }
            }
            if let error {
                let nsError = error as NSError
                continuation.yield(.failed(domain: nsError.domain, code: nsError.code))
                continuation.finish()
            }
        }
    }

    /// Stops capturing; the recognizer then delivers the final transcript and the
    /// `updates` stream finishes.
    func stop() {
        stopAudio()
        request?.endAudio()
    }

    /// Abandons the dictation without a final result.
    func cancel() {
        stopAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        request = nil
        continuation.finish()
    }

    private func stopAudio() {
        if engine.isRunning { engine.stop() }
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        deactivateAudioSession()
    }

    private func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// RMS level of the first channel mapped from -50…0 dBFS to 0…1.
    static func level(of buffer: AVAudioPCMBuffer) -> Double {
        guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
        let samples = channels[0]
        let count = Int(buffer.frameLength)
        var sum: Float = 0
        for index in 0..<count {
            let sample = samples[index]
            sum += sample * sample
        }
        let rms = (sum / Float(count)).squareRoot()
        let decibels = 20 * log10(Double(max(rms, 0.000_01)))
        return min(1, max(0, (decibels + 50) / 50))
    }
}
