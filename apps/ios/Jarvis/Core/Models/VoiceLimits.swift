import Foundation

/// The `VOICE_LIMITS` of packages/contracts/src/limits.ts (docs/architecture/phase-d.md §3.1).
/// scripts/check-contract-copy.ts verifies every value, including the stop phrases.
enum VoiceLimits {
    /// End of an utterance: this much silence after the last words (a preference).
    static let endOfSpeechSilenceMsDefault = 1_200
    static let endOfSpeechSilenceMsMin = 600
    static let endOfSpeechSilenceMsMax = 4_000
    /// Speech rate multiplier (1 = the platform's normal rate).
    static let speakingRateDefault = 1.0
    static let speakingRateMin = 0.5
    static let speakingRateMax = 2.0
    /// A conversation ends by itself after this long without speech (announced first).
    static let idleEndSeconds = 120
    /// Recognition / request retry delays (ms); then the session ends with the error shown.
    static let reconnectDelaysMs = [500, 1_000, 2_000, 5_000, 10_000]
    /// Characters spoken per chunk (sentence-split; longer sentences split at commas).
    static let maxSpokenChunkChars = 300
    /// Voice identifiers stored per locale.
    static let maxVoiceNameChars = 200

    /// Whole utterances that end voice mode (never sent as a request; a running task keeps
    /// running). Compared after `VoiceText.normalize`.
    static let stopPhrases: [AppLocale: [String]] = [
        .en: ["stop", "stop listening", "end conversation", "goodbye jarvis"],
        .de: ["stopp", "stop", "aufhören", "gespräch beenden", "tschüss jarvis"],
        .ar: ["توقف", "قف", "أنهِ المحادثة", "إنهاء المحادثة", "مع السلامة جارفيس"],
    ]

    static func clampSilence(_ milliseconds: Int) -> Int {
        min(endOfSpeechSilenceMsMax, max(endOfSpeechSilenceMsMin, milliseconds))
    }

    static func clampRate(_ rate: Double) -> Double {
        guard rate.isFinite else { return speakingRateDefault }
        return min(speakingRateMax, max(speakingRateMin, rate))
    }
}
