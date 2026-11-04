import Foundation

// Mirrors the Phase C OAuth shapes in packages/contracts/src/schemas.ts
// (ConnectionProviderInfo, OAuthStart*, OAuthCallback*). The authorization code flow
// with PKCE runs on the server: the app only opens the provider's page and forwards
// the redirect's query parameters, verbatim, with its own session.

/// What a connection provider is on this server (`GET /v1/connections/providers`).
struct ConnectionProviderInfo: Decodable, Sendable, Equatable {
    enum Kind: String, Codable, Sendable {
        case oauth
        case smtp
        case web
        case unknown

        init(from decoder: any Decoder) throws {
            self = try LenientEnum.decode(decoder, fallback: .unknown)
        }
    }

    /// What disconnecting does at the provider.
    enum Revocation: String, Codable, Sendable {
        /// The grant is revoked at the provider (Google).
        case provider
        /// The provider has no per-app revocation: JARVIS erases its tokens and the user
        /// may also remove the app in their account settings (Microsoft).
        case localOnly = "local_only"
        case unknown

        init(from decoder: any Decoder) throws {
            self = try LenientEnum.decode(decoder, fallback: .unknown)
        }
    }

    /// A capability with the exact provider scopes it requests.
    struct CapabilityScopes: Decodable, Sendable, Equatable {
        let capability: ConnectionCapability
        let scopes: [String]
    }

    let provider: ConnectionProvider
    let kind: Kind
    /// OAuth: the server has a client id and secret for it. false = "not configured on this server".
    let configured: Bool
    let capabilities: [CapabilityScopes]
    /// Scopes requested with every capability (account identity, staying connected).
    let identityScopes: [String]
    let revocation: Revocation?

    var oauthProvider: OAuthProvider? {
        guard kind == .oauth else { return nil }
        switch provider {
        case .google: return .google
        case .microsoft: return .microsoft
        case .web, .smtp, .unknown: return nil
        }
    }

    /// The exact scopes behind a capability (empty when the server lists none).
    func scopes(for capability: ConnectionCapability) -> [String] {
        capabilities.first { $0.capability == capability }?.scopes ?? []
    }
}

/// `POST /v1/connections/oauth/start`. `connectionId` adds capabilities to, or reconnects, an
/// existing connection of the same provider (the provider account must stay the same).
struct OAuthStartRequest: Encodable, Sendable, Equatable {
    let provider: OAuthProvider
    let capabilities: [ConnectionCapability]
    /// Exactly one of the server's allowed redirect URIs (OAUTH_REDIRECT_URIS).
    let redirectUri: String
    var connectionId: String? = nil
    var returnTo: String? = nil
}

struct OAuthStartResponse: Decodable, Sendable, Equatable {
    /// Opened with ASWebAuthenticationSession.
    let authorizationUrl: String
    /// The authorization must be completed before this.
    let expiresAt: Date
}

/// `POST /v1/connections/oauth/callback`: the provider's redirect, forwarded verbatim.
/// Exactly one of `code` and `error`.
struct OAuthCallbackRequest: Encodable, Sendable, Equatable {
    let state: String
    var code: String? = nil
    var error: String? = nil
    var errorDescription: String? = nil
    /// RFC 9207 issuer, when the provider sends one (the server checks it).
    var iss: String? = nil
}

struct OAuthCallbackResult: Decodable, Sendable, Equatable {
    let connection: Connection
    let returnTo: String?
    /// Recent tasks that failed because this connection had expired and can be retried now.
    let resumableTaskIds: [String]
}
