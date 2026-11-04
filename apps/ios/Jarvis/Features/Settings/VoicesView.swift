import AVFoundation
import SwiftUI

/// Formatting of the voice settings.
enum VoiceSettingsText {
    /// "1.2×" in the app's locale.
    static func rate(_ value: Double) -> String {
        "\(VoiceLimits.clampRate(value).formatted(.number.precision(.fractionLength(1))))×"
    }

    /// "1.2 s" in the app's locale.
    static func pause(_ milliseconds: Int) -> String {
        Measurement(value: Double(VoiceLimits.clampSilence(milliseconds)) / 1_000, unit: UnitDuration.seconds)
            .formatted(.measurement(width: .abbreviated, usage: .asProvided, numberFormatStyle: .number.precision(.fractionLength(1))))
    }
}

/// The voice JARVIS speaks with, per language (a voice this iPhone has; "System default"
/// otherwise), with a preview in that language.
struct VoicesView: View {
    @Bindable var model: SettingsModel
    @State private var preview = VoicePreviewSpeaker()

    private static let languages: [AppLocale] = [.en, .de, .ar]

    var body: some View {
        Form {
            ForEach(Self.languages, id: \.self) { language in
                VoiceLanguageSection(
                    language: language,
                    selection: binding(for: language),
                    rate: model.speakingRate,
                    preview: preview
                )
            }
        }
        .scrollContentBackground(.hidden)
        .background(MeridianColor.canvas)
        .navigationTitle(Text("Voices"))
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { preview.stop() }
    }

    private func binding(for language: AppLocale) -> Binding<String?> {
        switch language {
        case .de: $model.voiceNames.de
        case .ar: $model.voiceNames.ar
        case .en, .unknown: $model.voiceNames.en
        }
    }
}

private struct VoiceLanguageSection: View {
    let language: AppLocale
    @Binding var selection: String?
    let rate: Double
    let preview: VoicePreviewSpeaker

    private var voices: [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.split(separator: "-").first.map(String.init) == language.rawValue }
            .sorted { lhs, rhs in
                if lhs.quality != rhs.quality { return lhs.quality.rawValue > rhs.quality.rawValue }
                return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
            }
    }

    var body: some View {
        Section {
            Picker(selection: $selection) {
                Text("System default").tag(String?.none)
                ForEach(voices, id: \.identifier) { voice in
                    Text(verbatim: VoicePreviewSpeaker.label(voice)).tag(Optional(voice.identifier))
                }
            } label: {
                Text("Voice")
            }
            .pickerStyle(.navigationLink)
            if let selection, AVSpeechSynthesisVoice(identifier: selection) == nil {
                Text("The chosen voice isn't on this iPhone, so the system voice is used.")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.warning)
            }
            Button {
                preview.speak(sample, languageCode: languageCode, voiceIdentifier: selection, rate: rate)
            } label: {
                Label("Play a sample", systemImage: "play.circle")
            }
            .accessibilityHint(Text("Speaks a sentence with this voice and speaking rate"))
        } header: {
            Text(verbatim: language.languageName)
        }
    }

    private var languageCode: String {
        RecognitionLocale.auto.resolvedIdentifier(appLocale: language)
    }

    /// Always in the voice's own language.
    private var sample: String {
        switch language {
        case .de: "Hallo, ich bin JARVIS. So klinge ich."
        case .ar: "مرحبًا، أنا جارفيس. هكذا يبدو صوتي."
        case .en, .unknown: "Hello, I'm JARVIS. This is how I sound."
        }
    }
}

/// Speaks voice previews (playback only; nothing is recorded).
@MainActor
final class VoicePreviewSpeaker {
    private let synthesizer = AVSpeechSynthesizer()

    func speak(_ text: String, languageCode: String, voiceIdentifier: String?, rate: Double) {
        stop()
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
        } catch {
            return
        }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = LiveConversationSynthesizer.voice(identifier: voiceIdentifier, languageCode: languageCode)
        utterance.rate = LiveConversationSynthesizer.rate(rate)
        synthesizer.speak(utterance)
    }

    func stop() {
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
    }

    /// "Anna (Enhanced) · de-DE" — the voice's own name, its quality and its region.
    static func label(_ voice: AVSpeechSynthesisVoice) -> String {
        let quality: String? = switch voice.quality {
        case .premium: String(localized: "Premium")
        case .enhanced: String(localized: "Enhanced")
        default: nil
        }
        let name = quality.map { "\(voice.name) (\($0))" } ?? voice.name
        return "\(name) · \(voice.language)"
    }
}
