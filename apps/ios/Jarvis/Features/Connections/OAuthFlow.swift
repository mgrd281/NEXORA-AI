import AuthenticationServices
import Foundation
import Observation
import SwiftUI

// Connecting a Google or Microsoft account from the iPhone (docs/adr/0016-oauth-connections.md).
//
// The authorization code flow with PKCE (S256) runs on the SERVER: `POST
// /v1/connections/oauth/start` creates the state (bound to this app's session, single use,
// 10 minutes) and the PKCE verifier, and returns the provider's authorization URL. The app
// opens that URL in ASWebAuthenticationSession (an ephemeral browser session: no cookies
// shared with Safari, the user signs in at the provider, the app never sees a password),
// receives the provider's redirect to the shared https redirect URI, and forwards its query
// parameters verbatim to `POST /v1/connections/oauth/callback` with its bearer session. The
// server checks the state, exchanges the code with the client secret and stores the tokens
// sealed. No client secret, code verifier or token ever exists on the device.
//
// What has to be configured outside this code (the app cannot do any of it itself):
//
// 1. `JARVIS_OAUTH_REDIRECT_URI` (build setting, Config/*.xcconfig → Info.plist): an https
//    URI without query, fragment or port — normally the web app's callback page,
//    `https://<web origin>/connections/callback`. Empty (the default) disables connecting
//    from the iPhone, and the app says so instead of failing later.
// 2. The API's `OAUTH_REDIRECT_URIS` must contain exactly that string; the server refuses
//    anything else (`REDIRECT_URI_NOT_ALLOWED`).
// 3. The same URI must be an authorized redirect URI of the provider's OAuth client — the
//    server's confidential "Web application" client, not an iOS client:
//    Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs (and the
//    OAuth consent screen with the Gmail/Calendar scopes; restricted Gmail scopes need
//    Google's verification before a public launch);
//    Microsoft Entra admin center → App registrations → Authentication → platform "Web".
// 4. ASWebAuthenticationSession hands an https callback (`.https(host:path:)`, iOS 17.4+)
//    only to an app associated with that host: the Associated Domains capability on the App
//    ID (Apple Developer → Certificates, Identifiers & Profiles), the entitlement
//    `webcredentials:<host>` (Config/Jarvis.entitlements, opted in via
//    `JARVIS_ENTITLEMENTS` in Config/Local.xcconfig), and
//    `https://<host>/.well-known/apple-app-site-association` listing
//    `<Team ID>.ai.jarvis.app` under `webcredentials.apps`.
//
// A custom URL scheme is deliberately not used (ADR-0016): the redirect URI is the web
// client's, and any app can claim a custom scheme. If 2–4 are wrong the user sees the
// server's or the system's error; nothing is ever reported as connected unless the
// server's callback answer says so.

/// The https redirect URI this build hands to the server, split for ASWebAuthenticationSession.
struct OAuthRedirect: Sendable, Equatable {
    /// Exactly as configured (and as it must appear in the server's OAUTH_REDIRECT_URIS).
    let uri: String
    let host: String
    let path: String

    static let infoKey = "JARVIS_OAUTH_REDIRECT_URI"

    static func load(from bundle: Bundle = .main) -> OAuthRedirect? {
        let raw = (bundle.object(forInfoDictionaryKey: infoKey) as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return validate(raw)
    }

    /// https only, with a host and a path, and nothing ASWebAuthenticationSession's https
    /// callback can't match (no user, password, port, query or fragment).
    static func validate(_ raw: String) -> OAuthRedirect? {
        guard !raw.isEmpty, !raw.hasPrefix("$("),
              let components = URLComponents(string: raw),
              components.scheme?.lowercased() == "https",
              let host = components.host?.lowercased(), !host.isEmpty,
              components.user == nil, components.password == nil, components.port == nil,
              components.query == nil, components.fragment == nil,
              components.path.hasPrefix("/"), components.path.count > 1
        else { return nil }
        return OAuthRedirect(uri: raw, host: host, path: components.path)
    }

    /// The provider's redirect as the callback body: its parameters, verbatim. Nil when the
    /// URL isn't this redirect URI, a parameter is repeated, or it carries neither a code nor
    /// an error (the server would refuse it anyway; nothing is sent).
    func callbackRequest(from url: URL) -> OAuthCallbackRequest? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https",
              components.host?.lowercased() == host,
              components.path == path
        else { return nil }
        let items = components.queryItems ?? []
        let known: Set<String> = ["state", "code", "error", "error_description", "iss"]
        var values: [String: String] = [:]
        for item in items where known.contains(item.name) {
            // A repeated parameter is never guessed between.
            guard values[item.name] == nil else { return nil }
            values[item.name] = item.value ?? ""
        }
        guard let state = values["state"], (16...512).contains(state.contractLength) else { return nil }
        let iss = values["iss"].flatMap { $0.isEmpty ? nil : $0 }
        if let error = values["error"], !error.isEmpty {
            return OAuthCallbackRequest(
                state: state,
                error: error.prefix(contractLength: 200),
                errorDescription: values["error_description"].map { $0.prefix(contractLength: 2000) },
                iss: iss
            )
        }
        guard let code = values["code"], !code.isEmpty, code.contractLength <= 4096 else { return nil }
        return OAuthCallbackRequest(state: state, code: code, iss: iss)
    }
}

/// Runs one connect / reconnect / add-capabilities flow and reports its real result.
@MainActor
@Observable
final class OAuthConnector {
    enum Phase: Equatable {
        case idle
        /// Asking the server for the authorization URL.
        case starting
        /// The provider's sign-in page is open.
        case authorizing
        /// Forwarding the provider's answer to the server.
        case finishing
    }

    private(set) var phase: Phase = .idle
    private(set) var provider: OAuthProvider?
    private(set) var errorMessage: String?
    /// The server's answer to the last successful flow.
    private(set) var result: OAuthCallbackResult?

    let redirect: OAuthRedirect?

    init(redirect: OAuthRedirect? = OAuthRedirect.load()) {
        self.redirect = redirect
    }

    var isRunning: Bool { phase != .idle }

    /// Connecting from this iPhone is set up in this build (see the configuration notes above).
    var isAvailable: Bool { redirect != nil }

    func clearResult() {
        result = nil
        errorMessage = nil
    }

    /// Connects `provider` for `capabilities` (or, with `connectionId`, reconnects that
    /// connection / adds capabilities to it). Returns the server's callback result, or nil
    /// when nothing was connected (cancelled, refused, or an error, then in `errorMessage`).
    func connect(
        provider: OAuthProvider,
        capabilities: [ConnectionCapability],
        connectionId: String?,
        session: WebAuthenticationSession,
        api: APIClient
    ) async -> OAuthCallbackResult? {
        guard phase == .idle else { return nil }
        guard let redirect else {
            errorMessage = String(localized: "Connecting accounts isn't set up in this version of the app. Connect on the web; the connection then works here too.")
            return nil
        }
        let wanted = ConnectionCapability.selectable.filter { capabilities.contains($0) }
        guard provider != .unknown, !wanted.isEmpty else {
            errorMessage = String(localized: "Choose at least one thing JARVIS may do.")
            return nil
        }
        self.provider = provider
        errorMessage = nil
        result = nil
        defer { phase = .idle }
        do {
            phase = .starting
            let start = try await api.startOAuth(
                OAuthStartRequest(
                    provider: provider,
                    capabilities: wanted,
                    redirectUri: redirect.uri,
                    connectionId: connectionId
                )
            )
            guard let url = Self.authorizationURL(start.authorizationUrl) else {
                errorMessage = String(localized: "The server sent a sign-in address this app won't open.")
                return nil
            }
            phase = .authorizing
            let callbackURL = try await session.authenticate(
                using: url,
                callback: .https(host: redirect.host, path: redirect.path),
                preferredBrowserSession: .ephemeral,
                additionalHeaderFields: [:]
            )
            guard let request = redirect.callbackRequest(from: callbackURL) else {
                errorMessage = String(localized: "The sign-in returned an answer JARVIS can't use, so nothing was connected. Start again.")
                return nil
            }
            phase = .finishing
            let answer = try await api.completeOAuth(request)
            result = answer
            return answer
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            // The user closed the sign-in sheet: nothing was connected, and that's not an error.
            return nil
        } catch is CancellationError {
            return nil
        } catch let error as ASWebAuthenticationSessionError {
            errorMessage = error.code == .presentationContextNotProvided || error.code == .presentationContextInvalid
                ? String(localized: "The sign-in window couldn't open. Try again.")
                : String(localized: "The sign-in couldn't finish, so nothing was connected. Try again.")
            return nil
        } catch {
            errorMessage = ErrorText.message(for: error)
            return nil
        }
    }

    /// The provider page to open: https only (plain http solely for local development
    /// providers on this device's loopback address).
    nonisolated static func authorizationURL(_ raw: String) -> URL? {
        guard let components = URLComponents(string: raw),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(), !host.isEmpty,
              components.user == nil, components.password == nil,
              let url = components.url
        else { return nil }
        if scheme == "https" { return url }
        if scheme == "http", ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) { return url }
        return nil
    }
}
