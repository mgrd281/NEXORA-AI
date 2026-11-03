import Foundation

/// An error response from the JARVIS API (`ApiErrorBody`), with the HTTP status.
struct ApiError: Error, Sendable, Equatable {
    let code: ErrorCode
    /// Server-authored message (English). Prefer `ErrorText` for user-facing copy.
    let message: String
    /// Correlates with the server log; shown for unexpected failures so support can find it.
    let requestId: String?
    let httpStatus: Int
    let details: [String: JSONValue]?

    init(
        code: ErrorCode,
        message: String,
        requestId: String? = nil,
        httpStatus: Int,
        details: [String: JSONValue]? = nil
    ) {
        self.code = code
        self.message = message
        self.requestId = requestId
        self.httpStatus = httpStatus
        self.details = details
    }

    /// Decodes an `ApiErrorBody`; falls back to a generic error when the body is not one
    /// (for example an HTML page from a proxy).
    static func from(data: Data, httpStatus: Int, decoder: JSONDecoder) -> ApiError {
        if let body = try? decoder.decode(ApiErrorBody.self, from: data) {
            return ApiError(
                code: body.error.code,
                message: body.error.message,
                requestId: body.error.requestId,
                httpStatus: httpStatus,
                details: body.error.details
            )
        }
        let fallback: ErrorCode
        switch httpStatus {
        case 401: fallback = .unauthenticated
        case 403: fallback = .forbidden
        case 404: fallback = .notFound
        case 409: fallback = .conflict
        case 429: fallback = .rateLimited
        case 400, 422: fallback = .validationFailed
        default: fallback = httpStatus >= 500 ? .internalError : .unknown
        }
        return ApiError(
            code: fallback,
            message: HTTPURLResponse.localizedString(forStatusCode: httpStatus),
            httpStatus: httpStatus
        )
    }
}

/// A failure before a well-formed API response was received.
enum NetworkError: Error, Sendable, Equatable {
    /// The device is offline.
    case offline
    case timedOut
    /// The server could not be reached (wrong address, server down, TLS failure).
    case cannotConnect
    /// The response was not HTTP, or a success body did not match the contract.
    case invalidResponse(String)
    /// The app has no stored session; the user must sign in.
    case notSignedIn

    init(_ error: URLError) {
        switch error.code {
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed,
             .internationalRoamingOff:
            self = .offline
        case .timedOut:
            self = .timedOut
        default:
            self = .cannotConnect
        }
    }
}
