import AVFoundation
import Foundation

// Natural voice: JARVIS's replies read aloud by the server's neural text-to-speech
// (POST /v1/voice/speech, only text is sent). The device voice stays the fallback whenever
// the server has no speech provider, the user turned external models off, or a request fails.

/// Plays one MP3 at a time and reports when it ended.
@MainActor
final class NaturalVoicePlayer: NSObject, AVAudioPlayerDelegate {
    private var player: AVAudioPlayer?
    private var onFinish: (@MainActor (Bool) -> Void)?

    /// Starts playing; false when the data could not be played (the caller falls back).
    func play(_ data: Data, onFinish: @escaping @MainActor (Bool) -> Void) -> Bool {
        stop()
        guard let next = try? AVAudioPlayer(data: data) else { return false }
        next.delegate = self
        player = next
        self.onFinish = onFinish
        next.prepareToPlay()
        guard next.play() else {
            player = nil
            self.onFinish = nil
            return false
        }
        return true
    }

    /// Stops at once; the finish callback of the stopped audio is not called.
    func stop() {
        onFinish = nil
        player?.stop()
        player = nil
    }

    var isPlaying: Bool { player?.isPlaying ?? false }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let id = ObjectIdentifier(player)
        Task { @MainActor in self.finished(id, flag) }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: (any Error)?) {
        let id = ObjectIdentifier(player)
        Task { @MainActor in self.finished(id, false) }
    }

    private func finished(_ id: ObjectIdentifier, _ ok: Bool) {
        guard let current = player, ObjectIdentifier(current) == id else { return }
        let callback = onFinish
        onFinish = nil
        player = nil
        callback?(ok)
    }
}

/// `ConversationSynthesizer` that speaks with the natural voice and falls back to the device
/// voice (`LiveConversationSynthesizer`) for a chunk that could not be fetched or played.
/// After two failures in a row it stays on the device voice for the rest of the conversation.
@MainActor
final class NaturalConversationSynthesizer: ConversationSynthesizer {
    let isSupported = true
    private let api: APIClient
    private let fallback: LiveConversationSynthesizer
    private let player = NaturalVoicePlayer()
    private var generation = 0
    private var request: Task<Void, Never>?
    private var failures = 0

    init(api: APIClient) {
        self.api = api
        fallback = LiveConversationSynthesizer()
    }

    func speak(
        _ text: String,
        languageCode: String,
        voiceIdentifier: String?,
        rate: Double,
        onFinish: @escaping @MainActor @Sendable (Bool) -> Void
    ) {
        generation += 1
        let current = generation
        guard failures < 2 else {
            fallback.speak(text, languageCode: languageCode, voiceIdentifier: voiceIdentifier, rate: rate, onFinish: onFinish)
            return
        }
        try? ConversationAudioSession.activate()
        let api = self.api
        request = Task { [weak self] in
            let data = try? await api.speech(text: text, language: AppLocale(recognitionIdentifier: languageCode))
            guard let self, !Task.isCancelled, current == self.generation else { return }
            if let data, self.player.play(data, onFinish: { [weak self] ok in
                guard let self, current == self.generation else { return }
                onFinish(ok)
            }) {
                self.failures = 0
                return
            }
            self.failures += 1
            self.fallback.speak(
                text,
                languageCode: languageCode,
                voiceIdentifier: voiceIdentifier,
                rate: rate,
                onFinish: onFinish
            )
        }
    }

    func cancel() {
        generation += 1
        request?.cancel()
        request = nil
        player.stop()
        fallback.cancel()
    }

    func shutdown() {
        cancel()
        fallback.shutdown()
    }
}
