import Foundation

// Mirrors the "Account" section of packages/contracts/src/schemas.ts.

struct Preferences: Decodable, Sendable, Equatable {
    struct Voice: Decodable, Sendable, Equatable {
        /// Read final results aloud after a voice request.
        var speakResponses: Bool
        var recognitionLocale: RecognitionLocale
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
}

/// `PATCH /v1/me`. Every field is optional; `nil` fields are omitted from the JSON.
struct UpdateMeRequest: Encodable, Sendable, Equatable {
    var displayName: String?
    var locale: AppLocale?
    var timeZone: String?
    var theme: ThemePreference?
    var preferences: PreferencesPatch?
}

struct PreferencesPatch: Encodable, Sendable, Equatable {
    struct Voice: Encodable, Sendable, Equatable {
        var speakResponses: Bool?
        var recognitionLocale: RecognitionLocale?
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

    var voice: Voice?
    var autonomy: Autonomy?
    var ai: AI?
    var retention: Retention?
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
