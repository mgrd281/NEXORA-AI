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

    var voice: Voice
    var autonomy: Autonomy
    var ai: AI
    var notifications: Notifications
    var spending: Spending
    var memory: MemorySettings
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

    var voice: Voice?
    var autonomy: Autonomy?
    var ai: AI?
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
