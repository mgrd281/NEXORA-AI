import Foundation

// Memory, Connection, StreamEvent, voice-session and pagination shapes from
// packages/contracts/src/schemas.ts and routes.ts.

struct Memory: Decodable, Sendable, Equatable, Identifiable {
    enum Source: String, Codable, Sendable {
        case user
        case assistant
        case unknown

        init(from decoder: any Decoder) throws {
            self = try LenientEnum.decode(decoder, fallback: .unknown)
        }
    }

    let id: String
    let kind: MemoryKind
    let content: String
    let source: Source
    let sourceTaskId: String?
    let createdAt: Date
    let updatedAt: Date
}

/// `POST /v1/memories`.
struct CreateMemoryRequest: Encodable, Sendable, Equatable {
    let kind: MemoryKind
    let content: String
}

struct Connection: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let provider: ConnectionProvider
    let label: String
    /// e.g. the sender address for SMTP, the account's address for Google / Microsoft;
    /// never a secret.
    let accountIdentifier: String?
    let status: ConnectionStatus
    let permissions: [String]
    let lastVerifiedAt: Date?
    let lastError: String?
    let expiresAt: Date?
    let createdAt: Date
    // Phase C. Always sent by the current API; nil from older servers.
    /// OAuth connections: what JARVIS may do with it (every scope granted); [] otherwise.
    var capabilities: [ConnectionCapability]? = nil
    /// OAuth connections: the provider scopes actually granted (shown for transparency).
    var scopes: [String]? = nil
    /// Why it isn't active (nil while active); an expired connection is fixed by reconnecting.
    var statusReason: ConnectionStatusReason? = nil

    /// The OAuth provider of a Google or Microsoft connection.
    var oauthProvider: OAuthProvider? {
        switch provider {
        case .google: .google
        case .microsoft: .microsoft
        case .web, .smtp, .unknown: nil
        }
    }

    /// Capabilities this build knows (unknown ones from a newer server are never requested).
    var knownCapabilities: [ConnectionCapability] {
        let granted = Set(capabilities ?? [])
        return ConnectionCapability.selectable.filter { granted.contains($0) }
    }

    /// Expired (or revoked at the provider): nothing works until the user reconnects.
    var needsReconnect: Bool {
        oauthProvider != nil && (status == .expired || status == .revoked)
    }

    func grants(_ capability: ConnectionCapability) -> Bool {
        status == .active && (capabilities ?? []).contains(capability)
    }
}

/// One message of `GET /v1/events` (Server-Sent Events).
struct StreamEvent: Decodable, Sendable, Equatable, Identifiable {
    /// The `task_events` id for persisted events; `eph-…` for ephemeral ones.
    let id: String
    let type: EventType
    let taskId: String?
    let at: Date
    let data: [String: JSONValue]
}

/// `POST /v1/voice-sessions` — metadata only; audio never leaves the device through JARVIS.
struct VoiceSessionStartRequest: Encodable, Sendable, Equatable {
    let locale: String
    let engine: String
    /// Phase D: one dictated request (the server's default) or a continuous conversation.
    var mode: VoiceSessionMode? = nil
    /// Phase D: the conversation a voice conversation continues (follow-ups); must be the caller's.
    var conversationId: String? = nil
}

/// `POST /v1/voice-sessions/:id/end`. Counters only — never audio, never transcripts.
struct VoiceSessionEndRequest: Encodable, Sendable, Equatable {
    enum Outcome: String, Encodable, Sendable {
        case submitted
        case cancelled
        case error
        case noSpeech = "no_speech"
        /// Phase D: a conversation the user ended after at least one request.
        case ended
    }

    let outcome: Outcome
    let transcriptChars: Int
    let errorCode: String?
    // Phase D (conversation counters; nil fields are omitted)
    var turns: Int? = nil
    var bargeIns: Int? = nil
    var reconnects: Int? = nil
    var endReason: VoiceEndReason? = nil
}

struct VoiceSession: Decodable, Sendable, Equatable {
    let id: String
    let startedAt: Date
    let endedAt: Date?
    // Phase D (optional: older servers)
    var mode: VoiceSessionMode? = nil
    var conversationId: String? = nil
}

/// `Page(item)` — cursor pagination.
struct Page<Item: Decodable & Sendable>: Decodable, Sendable {
    let items: [Item]
    let nextCursor: String?
}

/// `{ items: [...] }` without pagination.
struct ItemList<Item: Decodable & Sendable>: Decodable, Sendable {
    let items: [Item]
}

/// Body of every non-2xx JSON response (`ApiErrorBody`).
struct ApiErrorBody: Decodable, Sendable, Equatable {
    struct Payload: Decodable, Sendable, Equatable {
        let code: ErrorCode
        let message: String
        let requestId: String?
        let details: [String: JSONValue]?
    }

    let error: Payload
}

/// Stand-in response type for 204 No Content.
struct EmptyResponse: Decodable, Sendable, Equatable {}
