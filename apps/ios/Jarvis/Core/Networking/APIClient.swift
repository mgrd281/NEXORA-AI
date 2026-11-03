import Foundation

enum HTTPMethod: String, Sendable {
    case get = "GET"
    case post = "POST"
    case patch = "PATCH"
    case delete = "DELETE"
}

/// The JARVIS HTTP API (routes in packages/contracts/src/routes.ts).
///
/// - Authenticates with the bearer token stored in the Keychain.
/// - Sends `Idempotency-Key` on the idempotent mutations (create task, retry, decide approval).
/// - Maps error bodies to `ApiError`; a 401 on an authenticated request clears the stored
///   credential and notifies the app so it can return to sign-in.
actor APIClient {
    nonisolated let baseURL: URL
    private let session: URLSession
    private let credentials: CredentialStore
    private let decoder = JSONCoding.makeDecoder()
    private let encoder = JSONCoding.makeEncoder()

    private var credential: SessionCredential?
    private var credentialLoaded = false
    private var unauthorizedHandler: (@Sendable () async -> Void)?

    init(baseURL: URL, credentials: CredentialStore = .standard, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.credentials = credentials
        self.session = session
    }

    // MARK: Credential

    func setUnauthorizedHandler(_ handler: @escaping @Sendable () async -> Void) {
        unauthorizedHandler = handler
    }

    /// The current bearer token, if signed in (also used by the event stream).
    func bearerToken() -> String? {
        if !credentialLoaded {
            credential = credentials.load()
            credentialLoaded = true
        }
        if let current = credential, current.isExpired() {
            clearCredential()
        }
        return credential?.token
    }

    func hasCredential() -> Bool { bearerToken() != nil }

    func store(_ credential: SessionCredential) throws {
        try credentials.save(credential)
        self.credential = credential
        credentialLoaded = true
    }

    func clearCredential() {
        credential = nil
        credentialLoaded = true
        credentials.clear()
    }

    // MARK: Requests

    /// Builds the URL for an API path such as `/v1/tasks/<id>`. Path segments must
    /// already be percent-encoded (see `pathSegment(_:)`).
    static func makeURL(baseURL: URL, path: String, query: [URLQueryItem] = []) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        var basePath = components.percentEncodedPath
        while basePath.hasSuffix("/") { basePath.removeLast() }
        components.percentEncodedPath = basePath + path
        if !query.isEmpty {
            components.queryItems = query
            // URLComponents leaves "+" unescaped, which servers read as a space.
            components.percentEncodedQuery = components.percentEncodedQuery?
                .replacingOccurrences(of: "+", with: "%2B")
        }
        return components.url
    }

    private static let segmentAllowed = CharacterSet(
        charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
    )

    /// Percent-encodes one path segment (ids are UUIDs, so this is normally a no-op).
    static func pathSegment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: segmentAllowed) ?? ""
    }

    static func makeRequest(
        url: URL,
        method: HTTPMethod,
        body: Data?,
        token: String?,
        idempotencyKey: String?,
        language: String
    ) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(language, forHTTPHeaderField: "Accept-Language")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let idempotencyKey {
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }
        if let body {
            // Only when there is a body: Fastify rejects an empty body declared as JSON.
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        return request
    }

    /// Sends a request and decodes the success body as `Response`.
    /// Use `EmptyResponse` for 204 No Content routes.
    func send<Response: Decodable & Sendable>(
        _ method: HTTPMethod,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (any Encodable & Sendable)? = nil,
        idempotencyKey: String? = nil,
        authenticated: Bool = true,
        signOutOnUnauthorized: Bool = true,
        as type: Response.Type = Response.self
    ) async throws -> Response {
        guard let url = Self.makeURL(baseURL: baseURL, path: path, query: query) else {
            throw NetworkError.invalidResponse("Invalid URL for \(path)")
        }
        var token: String?
        if authenticated {
            guard let current = bearerToken() else { throw NetworkError.notSignedIn }
            token = current
        }
        let bodyData = try body.map { try encoder.encode($0) }
        let request = Self.makeRequest(
            url: url,
            method: method,
            body: bodyData,
            token: token,
            idempotencyKey: idempotencyKey,
            language: AppLocale.current.rawValue
        )

        let (data, http) = try await transfer(request)

        if (200..<300).contains(http.statusCode) {
            if let empty = EmptyResponse() as? Response { return empty }
            do {
                return try decoder.decode(Response.self, from: data)
            } catch {
                throw NetworkError.invalidResponse(
                    "Unexpected \(Response.self) body: \(String(describing: error))"
                )
            }
        }

        let apiError = ApiError.from(data: data, httpStatus: http.statusCode, decoder: decoder)
        if http.statusCode == 401, authenticated {
            // The session was revoked or expired on the server.
            let hadCredential = credential != nil
            clearCredential()
            if hadCredential, signOutOnUnauthorized, let handler = unauthorizedHandler {
                await handler()
            }
        }
        throw apiError
    }

    private func transfer(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw NetworkError.invalidResponse("Not an HTTP response")
            }
            return (data, http)
        } catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            throw NetworkError(error)
        }
    }
}
