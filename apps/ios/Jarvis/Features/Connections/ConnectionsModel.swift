import Foundation
import Observation

/// Google, Microsoft and the other connections, as the server reports them. Every change
/// (connect, reconnect, disconnect) is followed by a reload, so the screen never shows a
/// state the server doesn't have.
@MainActor
@Observable
final class ConnectionsModel {
    /// One OAuth provider's card: what the server offers and the user's connection, if any.
    struct ProviderCard: Identifiable, Equatable {
        let provider: OAuthProvider
        /// Nil when the server didn't list it (an older server).
        let info: ConnectionProviderInfo?
        let connection: Connection?

        var id: String { provider.rawValue }
        var configured: Bool { info?.configured ?? false }

        /// Capabilities the server lists for this provider, in order.
        var offered: [ConnectionCapability] {
            guard let info else { return [] }
            let listed = Set(info.capabilities.map(\.capability))
            return ConnectionCapability.selectable.filter { listed.contains($0) }
        }

        /// Offered capabilities the connection doesn't grant yet.
        var notYetGranted: [ConnectionCapability] {
            let granted = Set(connection?.knownCapabilities ?? [])
            return offered.filter { !granted.contains($0) }
        }
    }

    private(set) var providers: [ConnectionProviderInfo] = []
    private(set) var connections: [Connection] = []
    private(set) var hasLoaded = false
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    /// The server didn't answer the providers route (older server): connecting is unavailable.
    private(set) var providersUnavailable = false
    private(set) var disconnectingIds: Set<String> = []
    private(set) var notice: String?

    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    var cards: [ProviderCard] {
        OAuthProvider.connectable.map { provider in
            ProviderCard(
                provider: provider,
                info: providers.first { $0.oauthProvider == provider },
                connection: connections.first(where: { $0.oauthProvider == provider && $0.status != .revoked })
                    ?? connections.first(where: { $0.oauthProvider == provider })
            )
        }
    }

    /// SMTP and web access (managed on the web).
    var otherConnections: [Connection] {
        connections.filter { $0.oauthProvider == nil }
    }

    var expiredCount: Int { connections.filter(\.needsReconnect).count }

    func load(api: APIClient) async {
        isLoading = true
        defer { isLoading = false }
        do {
            connections = try await api.connections()
            errorMessage = nil
            hasLoaded = true
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
        do {
            providers = try await api.connectionProviders()
            providersUnavailable = false
        } catch is CancellationError {
            return
        } catch let error as ApiError where error.code == .notFound {
            providersUnavailable = true
        } catch {
            if errorMessage == nil { errorMessage = ErrorText.message(for: error) }
        }
    }

    func handle(_ event: StreamEvent, api: APIClient) {
        guard event.type == .connectionChanged else { return }
        scheduleRefresh(api: api)
    }

    func scheduleRefresh(api: APIClient) {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await self?.load(api: api)
        }
    }

    /// Shows the connection the OAuth callback returned, then reloads.
    func apply(_ result: OAuthCallbackResult, api: APIClient) async {
        if let index = connections.firstIndex(where: { $0.id == result.connection.id }) {
            connections[index] = result.connection
        } else {
            connections.append(result.connection)
        }
        await load(api: api)
    }

    func disconnect(_ connection: Connection, api: APIClient) async {
        guard !disconnectingIds.contains(connection.id) else { return }
        disconnectingIds.insert(connection.id)
        defer { disconnectingIds.remove(connection.id) }
        errorMessage = nil
        notice = nil
        do {
            try await api.deleteConnection(id: connection.id)
            let name = connection.oauthProvider?.name ?? connection.provider.label
            notice = String(localized: "\(name) disconnected. Its tokens were erased.")
        } catch let error as ApiError where error.code == .notFound {
            // Already gone: the reload shows that.
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
        await load(api: api)
    }

    func clearNotice() { notice = nil }

    /// What a reconnect asks for: the connection's capabilities, plus one a failed step
    /// needed; never empty while the provider offers anything.
    nonisolated static func reconnectCapabilities(
        for connection: Connection?,
        adding extra: ConnectionCapability? = nil,
        offered: [ConnectionCapability]
    ) -> [ConnectionCapability] {
        var wanted = Set(connection?.knownCapabilities ?? [])
        if let extra, extra != .unknown { wanted.insert(extra) }
        let ordered = ConnectionCapability.selectable.filter { wanted.contains($0) }
        if !ordered.isEmpty { return ordered }
        return offered
    }
}

/// Retries the tasks a reconnect made resumable (`OAuthCallbackResult.resumableTaskIds`).
@MainActor
@Observable
final class ResumableTasksModel {
    struct Item: Identifiable, Equatable {
        let id: String
        var title: String?
        var state: State

        enum State: Equatable {
            case ready
            case retrying
            case retried
            case failed(String)
        }
    }

    private(set) var items: [Item]
    /// One key per task for the lifetime of this list, so a double tap or a re-send after a
    /// lost response replays the same retry instead of starting a second one.
    @ObservationIgnored private var keys: [String: String] = [:]

    init(taskIds: [String]) {
        items = taskIds.map { Item(id: $0, title: nil, state: .ready) }
    }

    func loadTitles(api: APIClient) async {
        for index in items.indices {
            let id = items[index].id
            let detail = try? await api.task(id: id)
            guard let detail else { continue }
            if let position = items.firstIndex(where: { $0.id == id }) {
                items[position].title = detail.displayTitle
            }
        }
    }

    func retry(_ id: String, api: APIClient) async {
        guard let index = items.firstIndex(where: { $0.id == id }), items[index].state != .retrying,
              items[index].state != .retried
        else { return }
        items[index].state = .retrying
        let key = keys[id] ?? UUID().uuidString
        keys[id] = key
        do {
            _ = try await api.retryTask(id: id, acknowledgeUnknownOutcome: false, idempotencyKey: key)
            setState(.retried, for: id)
        } catch is CancellationError {
            setState(.ready, for: id)
        } catch {
            setState(.failed(ErrorText.message(for: error)), for: id)
        }
    }

    private func setState(_ state: Item.State, for id: String) {
        if let index = items.firstIndex(where: { $0.id == id }) { items[index].state = state }
    }
}
