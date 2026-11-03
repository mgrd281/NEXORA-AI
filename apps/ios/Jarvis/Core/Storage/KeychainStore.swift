import Foundation
import Security

/// A single generic-password Keychain item.
///
/// Items use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable by the app
/// (and its Siri intent) in the background after the first unlock, never synced to
/// iCloud Keychain and never restored onto another device from a backup.
struct KeychainStore: Sendable {
    let service: String
    let account: String

    struct Failure: Error, Sendable, Equatable {
        let status: OSStatus
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// The stored bytes, or nil when there is no item.
    func read() throws -> Data? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            return result as? Data
        case errSecItemNotFound:
            return nil
        default:
            throw Failure(status: status)
        }
    }

    func write(_ data: Data) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else { throw Failure(status: updateStatus) }

        var item = baseQuery
        item.merge(attributes) { _, new in new }
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw Failure(status: addStatus) }
    }

    func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw Failure(status: status)
        }
    }
}

/// The signed-in session's bearer token, stored only in the Keychain.
struct SessionCredential: Codable, Sendable, Equatable {
    let token: String
    let sessionId: String
    let expiresAt: Date

    func isExpired(at now: Date = Date()) -> Bool { expiresAt <= now }
}

/// Reads and writes the `SessionCredential`. Shared by the app and the Siri intent.
struct CredentialStore: Sendable {
    let keychain: KeychainStore

    static let standard = CredentialStore(
        keychain: KeychainStore(service: "ai.jarvis.app.session", account: "primary")
    )

    /// The stored credential if present and not expired. Expired credentials are removed.
    func load() -> SessionCredential? {
        let data: Data?
        do {
            data = try keychain.read()
        } catch {
            // e.g. errSecInteractionNotAllowed before the first unlock: treat as absent but
            // keep the item, so the session is available again once the device is unlocked.
            return nil
        }
        guard let data else { return nil }
        guard let credential = try? JSONDecoder().decode(SessionCredential.self, from: data) else {
            try? keychain.delete()
            return nil
        }
        if credential.isExpired() {
            try? keychain.delete()
            return nil
        }
        return credential
    }

    func save(_ credential: SessionCredential) throws {
        try keychain.write(try JSONEncoder().encode(credential))
    }

    func clear() {
        try? keychain.delete()
    }
}
