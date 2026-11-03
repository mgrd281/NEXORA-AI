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
    /// e.g. the sender address for SMTP; never a secret.
    let accountIdentifier: String?
    let status: ConnectionStatus
    let permissions: [String]
    let lastVerifiedAt: Date?
    let lastError: String?
    let expiresAt: Date?
    let createdAt: Date
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
}

/// `POST /v1/voice-sessions/:id/end`.
struct VoiceSessionEndRequest: Encodable, Sendable, Equatable {
    enum Outcome: String, Encodable, Sendable {
        case submitted
        case cancelled
        case error
        case noSpeech = "no_speech"
    }

    let outcome: Outcome
    let transcriptChars: Int
    let errorCode: String?
}

struct VoiceSession: Decodable, Sendable, Equatable {
    let id: String
    let startedAt: Date
    let endedAt: Date?
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
