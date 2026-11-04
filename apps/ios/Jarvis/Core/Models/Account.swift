import Foundation

// Mirrors the "Account" section of packages/contracts/src/schemas.ts.

struct Preferences: Decodable, Sendable, Equatable {
    struct Voice: Decodable, Sendable, Equatable {
        /// The platform voice per language (an `AVSpeechSynthesisVoice` identifier); nil = the
        /// system's default voice for it. A voice this device lacks falls back to the default.
        struct VoiceNames: Decodable, Sendable, Equatable {
            var en: String?
            var de: String?
            var ar: String?

            static let defaults = VoiceNames(en: nil, de: nil, ar: nil)

            subscript(locale: AppLocale) -> String? {
                switch locale {
                case .en: en
                case .de: de
                case .ar: ar
                case .unknown: nil
                }
            }
        }

        /// Read final results aloud after a voice request.
        var speakResponses: Bool
        var recognitionLocale: RecognitionLocale
        // Phase D (defaults when absent, exactly as the contract's Zod defaults).
        /// Voice mode opens as a continuous conversation instead of one dictated request.
        var conversationMode: Bool = false
        /// Speech rate multiplier for JARVIS's voice (1 = normal).
        var speakingRate: Double = VoiceLimits.speakingRateDefault
        /// The pause that ends what you're saying, in milliseconds (WCAG 2.2.1: adjustable).
        var endOfSpeechSilenceMs: Int = VoiceLimits.endOfSpeechSilenceMsDefault
        var voiceNames: VoiceNames = .defaults

        private enum CodingKeys: String, CodingKey {
            case speakResponses, recognitionLocale, conversationMode, speakingRate, endOfSpeechSilenceMs, voiceNames
        }

        init(
            speakResponses: Bool,
            recognitionLocale: RecognitionLocale,
            conversationMode: Bool = false,
            speakingRate: Double = VoiceLimits.speakingRateDefault,
            endOfSpeechSilenceMs: Int = VoiceLimits.endOfSpeechSilenceMsDefault,
            voiceNames: VoiceNames = .defaults
        ) {
            self.speakResponses = speakResponses
            self.recognitionLocale = recognitionLocale
            self.conversationMode = conversationMode
            self.speakingRate = speakingRate
            self.endOfSpeechSilenceMs = endOfSpeechSilenceMs
            self.voiceNames = voiceNames
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            speakResponses = try container.decode(Bool.self, forKey: .speakResponses)
            recognitionLocale = try container.decode(RecognitionLocale.self, forKey: .recognitionLocale)
            conversationMode = try container.decodeIfPresent(Bool.self, forKey: .conversationMode) ?? false
            speakingRate = try container.decodeIfPresent(Double.self, forKey: .speakingRate) ?? VoiceLimits.speakingRateDefault
            endOfSpeechSilenceMs = try container.decodeIfPresent(Int.self, forKey: .endOfSpeechSilenceMs)
                ?? VoiceLimits.endOfSpeechSilenceMsDefault
            voiceNames = try container.decodeIfPresent(VoiceNames.self, forKey: .voiceNames) ?? .defaults
        }
    }

    struct Autonomy: Decodable, Sendable, Equatable {
        /// MEDIUM-risk emails addressed only to the account's own address run without asking.
        var autoApproveEmailToSelf: Bool
    }

    struct AI: Decodable, Sendable, Equatable {
        /// When false, requests are never sent to external model providers.
        var allowExternalModels: Bool
    }

    struct Notifications: Decodable, Sendable, Equatable {
        var approvalRequested: Bool
        var taskCompleted: Bool
        var taskFailed: Bool
    }

    struct Spending: Decodable, Sendable, Equatable {
        /// Monthly ceiling for AI model costs, in USD.
        var monthlyAiBudgetUsd: Double
        /// Phase C: the most JARVIS may spend on purchases per calendar month (account time
        /// zone), in USD. 0 (the default, also for older servers) turns purchases off. Every
        /// purchase still needs an approval of its exact total.
        var monthlyPurchaseLimitUsd: Double

        init(monthlyAiBudgetUsd: Double, monthlyPurchaseLimitUsd: Double = 0) {
            self.monthlyAiBudgetUsd = monthlyAiBudgetUsd
            self.monthlyPurchaseLimitUsd = monthlyPurchaseLimitUsd
        }

        private enum CodingKeys: String, CodingKey {
            case monthlyAiBudgetUsd, monthlyPurchaseLimitUsd
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            monthlyAiBudgetUsd = try container.decode(Double.self, forKey: .monthlyAiBudgetUsd)
            // Defaults to 0 when absent, exactly as the contract's Zod default does.
            monthlyPurchaseLimitUsd = try container.decodeIfPresent(Double.self, forKey: .monthlyPurchaseLimitUsd) ?? 0
        }

        /// Purchases are off while the limit is 0.
        var purchasesEnabled: Bool { monthlyPurchaseLimitUsd > 0 }
    }

    struct MemorySettings: Decodable, Sendable, Equatable {
        var enabled: Bool
    }

    /// Automatic deletion (Phase B). nil days = keep until the user deletes it.
    struct Retention: Decodable, Sendable, Equatable {
        var memoryDays: Int?
        var taskHistoryDays: Int?

        static let keepEverything = Retention(memoryDays: nil, taskHistoryDays: nil)
    }

    /// Skills the user switched off (Phase B; written through `PATCH /v1/skills/:id`).
    struct SkillSettings: Decodable, Sendable, Equatable {
        var disabled: [SkillId]
    }

    var voice: Voice
    var autonomy: Autonomy
    var ai: AI
    var notifications: Notifications
    var spending: Spending
    var memory: MemorySettings
    var retention: Retention
    var skills: SkillSettings
}

extension Preferences {
    private enum CodingKeys: String, CodingKey {
        case voice, autonomy, ai, notifications, spending, memory, retention, skills
    }

    /// `retention` and `skills` default when absent (stored preferences and servers older
    /// than Phase B), exactly as the contract's Zod defaults do.
    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        voice = try container.decode(Voice.self, forKey: .voice)
        autonomy = try container.decode(Autonomy.self, forKey: .autonomy)
        ai = try container.decode(AI.self, forKey: .ai)
        notifications = try container.decode(Notifications.self, forKey: .notifications)
        spending = try container.decode(Spending.self, forKey: .spending)
        memory = try container.decode(MemorySettings.self, forKey: .memory)
        retention = try container.decodeIfPresent(Retention.self, forKey: .retention) ?? .keepEverything
        skills = try container.decodeIfPresent(SkillSettings.self, forKey: .skills) ?? SkillSettings(disabled: [])
    }
}

/// A retention choice: keep until deleted, or delete after a number of days.
enum RetentionSetting: Hashable, Sendable {
    case forever
    case days(Int)

    init(days: Int?) {
        self = days.map { .days($0) } ?? .forever
    }

    var days: Int? {
        switch self {
        case .forever: nil
        case .days(let days): days
        }
    }

    /// `MEMORY_RETENTION_DAYS` with "keep until deleted" first.
    static let memoryChoices: [RetentionSetting] = [.forever, .days(30), .days(90), .days(365)]
    /// `TASK_HISTORY_RETENTION_DAYS` with "keep until deleted" first.
    static let taskHistoryChoices: [RetentionSetting] = [.forever, .days(90), .days(365)]
}

struct Tenant: Decodable, Sendable, Equatable {
    let id: String
    let name: String
}

struct Me: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let email: String
    let displayName: String
    let locale: AppLocale
    let timeZone: String
    let theme: ThemePreference
    let roles: [Role]
    let tenant: Tenant
    let preferences: Preferences
    let createdAt: Date
    // Phase D (absent from older servers).
    /// The account's own number (E.164), used only to put a callee through to you and as the
    /// country of numbers written without one. Personal data.
    var phoneNumber: String? = nil
    /// When a verification call confirmed it (transfers need it); nil = not verified.
    var phoneNumberVerifiedAt: Date? = nil
}

/// A change of a nullable field in a PATCH: a new value, or an explicit JSON null that removes
/// (or resets) it. Leaving the field nil omits it, which keeps the stored value.
enum NullablePatch<Value: Encodable & Sendable & Equatable>: Encodable, Sendable, Equatable {
    case set(Value)
    case remove

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .set(let value): try container.encode(value)
        case .remove: try container.encodeNil()
        }
    }
}

/// `PATCH /v1/me`. Every field is optional; `nil` fields are omitted from the JSON.
struct UpdateMeRequest: Encodable, Sendable, Equatable {
    var displayName: String?
    var locale: AppLocale?
    var timeZone: String?
    var theme: ThemePreference?
    /// Phase D: `.set("+49…")` (E.164) or `.remove`. A different number clears its verification.
    var phoneNumber: NullablePatch<String>?
    var preferences: PreferencesPatch?
}

struct PreferencesPatch: Encodable, Sendable, Equatable {
    struct Voice: Encodable, Sendable, Equatable {
        /// Per language: nil keeps the stored voice, `.remove` resets it to the default.
        struct VoiceNames: Encodable, Sendable, Equatable {
            var en: NullablePatch<String>?
            var de: NullablePatch<String>?
            var ar: NullablePatch<String>?
        }

        var speakResponses: Bool?
        var recognitionLocale: RecognitionLocale?
        // Phase D
        var conversationMode: Bool?
        var speakingRate: Double?
        var endOfSpeechSilenceMs: Int?
        var voiceNames: VoiceNames?
    }

    struct Autonomy: Encodable, Sendable, Equatable {
        var autoApproveEmailToSelf: Bool?
    }

    struct AI: Encodable, Sendable, Equatable {
        var allowExternalModels: Bool?
    }

    /// `preferences.retention` (partial). `.forever` is sent as an explicit null.
    struct Retention: Encodable, Sendable, Equatable {
        var memoryDays: RetentionSetting?
        var taskHistoryDays: RetentionSetting?

        private enum CodingKeys: String, CodingKey {
            case memoryDays, taskHistoryDays
        }

        func encode(to encoder: any Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            if let memoryDays { try Self.encode(memoryDays, in: &container, forKey: .memoryDays) }
            if let taskHistoryDays { try Self.encode(taskHistoryDays, in: &container, forKey: .taskHistoryDays) }
        }

        private static func encode(
            _ setting: RetentionSetting,
            in container: inout KeyedEncodingContainer<CodingKeys>,
            forKey key: CodingKeys
        ) throws {
            switch setting {
            case .forever: try container.encodeNil(forKey: key)
            case .days(let days): try container.encode(days, forKey: key)
            }
        }
    }

    /// `preferences.spending` (partial): a field left nil keeps its stored value.
    struct Spending: Encodable, Sendable, Equatable {
        var monthlyAiBudgetUsd: Double?
        var monthlyPurchaseLimitUsd: Double?
    }

    var voice: Voice?
    var autonomy: Autonomy?
    var ai: AI?
    var retention: Retention?
    var spending: Spending?
}

/// `POST /v1/auth/login`.
struct LoginRequest: Encodable, Sendable {
    let email: String
    let password: String
    let deviceName: String?
    let platform: Platform
}

struct LoginResponse: Decodable, Sendable {
    struct Session: Decodable, Sendable, Equatable {
        let id: String
        let expiresAt: Date
    }

    let user: Me
    let session: Session
    /// Returned to native clients only; the web uses an httpOnly cookie instead.
    let token: String?
}

struct SessionInfo: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let deviceName: String?
    let platform: Platform
    let userAgent: String?
    let createdAt: Date
    let lastUsedAt: Date
    let expiresAt: Date
    let current: Bool
}
