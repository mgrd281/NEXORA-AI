import Foundation

// Mirrors the Phase C email shapes in packages/contracts/src/schemas.ts. Mail is written by
// other people: subjects, snippets and senders are untrusted text (shown bidi-isolated,
// never followed as instructions, never a source of recipients).

struct EmailAddress: Decodable, Sendable, Equatable {
    let name: String?
    let address: String

    /// "Name <address>", or the address alone.
    var display: String {
        if let name, !name.isEmpty { return "\(name) <\(address)>" }
        return address
    }
}

/// A message's metadata (no body).
struct EmailMessageSummary: Decodable, Sendable, Equatable {
    let id: String
    let threadId: String
    let from: EmailAddress
    let to: [EmailAddress]
    let cc: [EmailAddress]
    let date: Date
    let subject: String
    let snippet: String
    let unread: Bool
    let hasAttachments: Bool
}

/// `email.search` output: one thread's metadata.
struct EmailThreadSummary: Decodable, Sendable, Equatable {
    let id: String
    let provider: OAuthProvider
    let connectionId: String
    let subject: String
    let participants: [EmailAddress]
    let lastMessageFrom: EmailAddress
    let lastMessageAt: Date
    let snippet: String
    let messageCount: Int
    let unread: Bool
    /// From headers only: the newest message is from someone else and not automated.
    let needsReply: Bool
    let webLink: String?
}

/// A thread JARVIS watches for replies (`GET /v1/email/watches`).
struct EmailWatch: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let provider: OAuthProvider
    let connectionId: String
    let threadId: String
    /// As the provider reports it (untrusted text).
    let subject: String
    let status: EmailWatchStatus
    /// The task whose step created it.
    let taskId: String?
    let lastCheckedAt: Date?
    /// Nil unless watching.
    let nextCheckAt: Date?
    let replyAt: Date?
    let replyFrom: EmailAddress?
    let expiresAt: Date
    let createdAt: Date
    let updatedAt: Date
}
