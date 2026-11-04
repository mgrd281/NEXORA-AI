import AVFoundation
import Foundation

/// Reads a task's final result aloud after a voice request, when the user enabled
/// "Speak responses": the natural voice's audio when the server provides it (`play`), else
/// the on-device system voice for the recognition language (`speak`).
@MainActor
final class ResponseSpeaker {
    private let synthesizer = AVSpeechSynthesizer()
    private let audioSessionReleaser = AudioSessionReleaser()
    private let natural = NaturalVoicePlayer()

    /// Plays natural-voice audio; false when it could not be played (then use `speak`).
    func play(_ audio: Data) -> Bool {
        stop()
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
        } catch {
            return false
        }
        return natural.play(audio) { _ in
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    init() {
        synthesizer.delegate = audioSessionReleaser
    }

    func speak(_ text: String, languageCode: String) {
        stop()
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
        } catch {
            return
        }
        let utterance = AVSpeechUtterance(string: String(text.prefix(2000)))
        utterance.voice = AVSpeechSynthesisVoice(language: languageCode)
        synthesizer.speak(utterance)
    }

    func stop() {
        natural.stop()
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
    }
}

/// Releases the audio session (un-ducking other audio) once speech ends.
private final class AudioSessionReleaser: NSObject, AVSpeechSynthesizerDelegate {
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        release(synthesizer)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        release(synthesizer)
    }

    private func release(_ synthesizer: AVSpeechSynthesizer) {
        // A cancelled utterance may be followed immediately by a new one.
        guard !synthesizer.isSpeaking else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
