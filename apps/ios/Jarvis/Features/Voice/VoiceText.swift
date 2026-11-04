import Foundation
import NaturalLanguage

/// Text rules of voice conversation mode (pure; unit-tested): utterance normalisation, the
/// spoken stop phrases of `VoiceLimits`, assent words that are never approvals, the echo guard
/// for barge-in, and sentence-by-sentence chunking of a streamed answer. The same rules as the
/// web client (apps/web/src/components/voice/engine/text.ts).
enum VoiceText {
    /// Lower-case, without punctuation, symbols or diacritics, single spaces: "Stopp!" → "stopp",
    /// "أنهِ المحادثة." → "انه المحادثه", "Aufhören" → "aufhoren". Both sides of every comparison
    /// go through this, so recognisers that add or drop marks still match.
    static func normalize(_ text: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in text.decomposedStringWithCompatibilityMapping.unicodeScalars {
            switch scalar.properties.generalCategory {
            case .nonspacingMark, .spacingMark, .enclosingMark:
                continue
            case .connectorPunctuation, .dashPunctuation, .openPunctuation, .closePunctuation,
                 .initialPunctuation, .finalPunctuation, .otherPunctuation,
                 .mathSymbol, .currencySymbol, .modifierSymbol, .otherSymbol:
                scalars.append(" ")
            default:
                switch scalar.value {
                case 0x0640: continue // tatweel
                case 0x0649: scalars.append("\u{064A}") // alef maqsura → yeh
                case 0x0629: scalars.append("\u{0647}") // teh marbuta → heh
                case 0x0671: scalars.append("\u{0627}") // alef wasla → alef
                default: scalars.append(scalar)
                }
            }
        }
        return String(scalars).lowercased()
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
    }

    private static let stopSets: [AppLocale: Set<String>] = VoiceLimits.stopPhrases.mapValues { Set($0.map(VoiceText.normalize)) }

    /// A whole utterance that ends voice mode ("stop", "stopp", "توقف" …) in the recognition
    /// language. Never sent as a request.
    static func isStopPhrase(_ text: String, locale: AppLocale) -> Bool {
        let normalized = normalize(text)
        guard !normalized.isEmpty else { return false }
        return (stopSets[locale] ?? stopSets[.en] ?? []).contains(normalized)
    }

    /// Spoken assent ("yes", "approve it", "ja, genehmigen", "نعم موافق"): an utterance made only
    /// of assent words. Approvals are never given by voice (ADR-0019): while one waits, these are
    /// answered with "confirm it on screen" and not kept as a request.
    private static let assentWords: [AppLocale: [String]] = [
        .en: ["yes", "yeah", "yep", "ok", "okay", "sure", "fine", "right", "correct", "please", "approve",
              "approved", "confirm", "confirmed", "go", "ahead", "do", "it", "i", "that", "this", "call"],
        .de: ["ja", "jawohl", "genau", "ok", "okay", "klar", "gut", "richtig", "bitte", "genehmigen",
              "genehmigt", "genehmige", "ich", "bestätigen", "bestätigt", "bestätige", "einverstanden",
              "freigeben", "mach", "das", "es", "los", "anrufen"],
        .ar: ["نعم", "أجل", "أيوه", "موافق", "أوافق", "وافق", "حسنا", "حسناً", "تمام", "أكد", "أؤكد",
              "تأكيد", "نفذ", "نفّذ", "اتصل", "من", "فضلك", "بالتأكيد"],
    ]
    private static let assentSets: [AppLocale: Set<String>] = assentWords.mapValues { Set($0.map(VoiceText.normalize)) }

    static func isAffirmation(_ text: String, locale: AppLocale) -> Bool {
        let words = normalize(text).split(separator: " ").map(String.init)
        let set = assentSets[locale] ?? assentSets[.en] ?? []
        return !words.isEmpty && words.allSatisfy { set.contains($0) }
    }

    /// The echo guard: recognised text contained in what JARVIS is (or just was) saying is its
    /// own voice picked up by the microphone, not the user.
    static func isEcho(_ heard: String, spoken: [String]) -> Bool {
        let normalized = normalize(heard)
        guard !normalized.isEmpty else { return true }
        return spoken.contains { normalize($0).contains(normalized) }
    }

    /// Recognition of one run is cumulative, so when the user talks over JARVIS the text starts
    /// with JARVIS's own words. Drops the longest leading run of at least two words that is
    /// contained in what was spoken, when words of the user's own remain.
    static func removingEchoPrefix(_ heard: String, spoken: [String]) -> String {
        let words = heard.split(whereSeparator: { $0.isWhitespace })
        guard words.count > 2 else { return heard }
        let spokenNormalized = spoken.map(normalize)
        for length in stride(from: words.count - 1, through: 2, by: -1) {
            let prefix = normalize(words[0..<length].joined(separator: " "))
            if !prefix.isEmpty, spokenNormalized.contains(where: { $0.contains(prefix) }) {
                return words[length...].joined(separator: " ")
            }
        }
        return heard
    }

    // MARK: Sentences

    /// The sentence ranges of `text` (NLTokenizer; a punctuation rule when it finds none).
    static func sentenceRanges(_ text: String, languageCode: String) -> [Range<String.Index>] {
        guard !text.isEmpty else { return [] }
        let tokenizer = NLTokenizer(unit: .sentence)
        tokenizer.string = text
        let base = languageCode.split(separator: "-").first.map(String.init) ?? languageCode
        tokenizer.setLanguage(NLLanguage(rawValue: base))
        var ranges: [Range<String.Index>] = []
        tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in
            ranges.append(range)
            return true
        }
        if !ranges.isEmpty { return ranges }
        // Fallback: end at . ! ? … ؟ or a line break.
        var result: [Range<String.Index>] = []
        var start = text.startIndex
        var index = text.startIndex
        while index < text.endIndex {
            let character = text[index]
            index = text.index(after: index)
            if ".!?…؟\n".contains(character) {
                result.append(start..<index)
                start = index
            }
        }
        if start < text.endIndex { result.append(start..<text.endIndex) }
        return result
    }

    /// The sentences of a growing answer that are complete: every sentence but the last (it may
    /// still grow) unless `final`. `from` is how much of `buffer` was taken already, in UTF-16
    /// code units (appending never moves it); returns the new sentences (trimmed, non-empty) and
    /// the new position.
    static func takeSentences(
        _ buffer: String,
        from: Int,
        final: Bool,
        languageCode: String
    ) -> (sentences: [String], next: Int) {
        let total = buffer.utf16.count
        guard from < total else { return ([], min(from, total)) }
        let startIndex = String.Index(utf16Offset: max(0, from), in: buffer)
        let rest = String(buffer[startIndex...])
        let ranges = sentenceRanges(rest, languageCode: languageCode)
        let complete = final ? ranges.count : max(0, ranges.count - 1)
        var sentences: [String] = []
        var next = from
        for position in 0..<complete {
            let text = rest[ranges[position]].trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { sentences.append(text) }
            if position + 1 < ranges.count {
                next = from + ranges[position + 1].lowerBound.utf16Offset(in: rest)
            } else {
                next = from + rest.utf16.count
            }
        }
        return (sentences, next)
    }

    /// Splits one sentence into spoken chunks of at most `max` characters: at commas first (also
    /// the Arabic comma and semicolons), then between words, then hard.
    static func chunkForSpeech(_ sentence: String, max limit: Int = VoiceLimits.maxSpokenChunkChars) -> [String] {
        let text = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return [] }
        guard text.count > limit else { return [text] }
        var out: [String] = []
        var current = ""
        func push() {
            let trimmed = current.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { out.append(trimmed) }
            current = ""
        }
        func fits(_ piece: String) -> Bool {
            (current.isEmpty ? 0 : current.count + 1) + piece.count <= limit
        }
        for clause in clauses(text) {
            if fits(clause) {
                current = current.isEmpty ? clause : "\(current) \(clause)"
                continue
            }
            push()
            if clause.count <= limit {
                current = clause
                continue
            }
            for word in clause.split(whereSeparator: { $0.isWhitespace }).map(String.init) {
                if fits(word) {
                    current = current.isEmpty ? word : "\(current) \(word)"
                    continue
                }
                push()
                var rest = Substring(word)
                while rest.count > limit {
                    out.append(String(rest.prefix(limit)))
                    rest = rest.dropFirst(limit)
                }
                current = String(rest)
            }
        }
        push()
        return out
    }

    /// Clauses ending at , ، ; ؛ followed by whitespace (the separator stays with its clause).
    private static func clauses(_ text: String) -> [String] {
        var result: [String] = []
        var current = ""
        var previousWasSeparator = false
        for character in text {
            if previousWasSeparator, character.isWhitespace {
                result.append(current)
                current = ""
                previousWasSeparator = false
                continue
            }
            if current.isEmpty, character.isWhitespace { continue }
            current.append(character)
            previousWasSeparator = ",،;؛".contains(character)
        }
        if !current.isEmpty { result.append(current) }
        return result
    }

    /// Text to speak: without the bidi isolation marks of rendered sentences, single spaces.
    static func plain(_ text: String) -> String {
        text.unicodeScalars
            .filter { !(0x2066...0x2069).contains($0.value) && $0.value != 0x200E && $0.value != 0x200F }
            .reduce(into: "") { $0.unicodeScalars.append($1) }
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
    }
}
