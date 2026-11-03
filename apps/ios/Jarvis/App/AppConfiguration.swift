import Foundation

/// Build-time configuration read from Info.plist (`JARVIS_API_BASE_URL`, set per
/// build configuration in Config/*.xcconfig).
struct AppConfiguration: Sendable, Equatable {
    let apiBaseURL: URL

    enum Problem: Error, Sendable, Equatable {
        case missing
        case invalid(String)
        case insecure(String)
    }

    static func load(from bundle: Bundle = .main) -> Result<AppConfiguration, Problem> {
        let raw = (bundle.object(forInfoDictionaryKey: "JARVIS_API_BASE_URL") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return validate(raw)
    }

    /// Bearer tokens are only ever sent over HTTPS — plain HTTP is accepted solely for
    /// loopback hosts (the simulator talking to a local API).
    static func validate(_ raw: String) -> Result<AppConfiguration, Problem> {
        guard !raw.isEmpty, !raw.hasPrefix("$(") else { return .failure(.missing) }
        guard let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              let host = url.host(), !host.isEmpty,
              url.query == nil, url.fragment == nil
        else { return .failure(.invalid(raw)) }
        switch scheme {
        case "https":
            return .success(AppConfiguration(apiBaseURL: url))
        case "http":
            let loopback = ["localhost", "127.0.0.1", "::1"]
            guard loopback.contains(host.lowercased()) else { return .failure(.insecure(raw)) }
            return .success(AppConfiguration(apiBaseURL: url))
        default:
            return .failure(.invalid(raw))
        }
    }
}
