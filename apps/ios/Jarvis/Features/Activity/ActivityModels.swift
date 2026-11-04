import Foundation
import Observation

/// A cursor-paged, read-only list (orders, bookings) that reloads on its stream events.
@MainActor
@Observable
final class PagedListModel<Item: Decodable & Sendable & Identifiable> {
    private(set) var items: [Item] = []
    private(set) var nextCursor: String?
    private(set) var hasLoaded = false
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    private let fetch: @Sendable (APIClient, String?) async throws -> Page<Item>
    private let eventType: EventType
    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    init(eventType: EventType, fetch: @escaping @Sendable (APIClient, String?) async throws -> Page<Item>) {
        self.eventType = eventType
        self.fetch = fetch
    }

    func load(api: APIClient) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await fetch(api, nil)
            items = page.items
            nextCursor = page.nextCursor
            hasLoaded = true
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    func loadMore(api: APIClient) async {
        guard let cursor = nextCursor, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await fetch(api, cursor)
            let known = Set(items.map(\.id))
            items.append(contentsOf: page.items.filter { !known.contains($0.id) })
            nextCursor = page.nextCursor
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    func handle(_ event: StreamEvent, api: APIClient) {
        guard event.type == eventType else { return }
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await self?.load(api: api)
        }
    }
}

/// One order or booking, reloaded when the stream says it changed.
@MainActor
@Observable
final class RecordModel<Record: Decodable & Sendable> {
    let id: String
    private(set) var record: Record?
    private(set) var errorMessage: String?

    private let fetch: @Sendable (APIClient, String) async throws -> Record
    private let eventType: EventType
    private let idKey: String

    init(id: String, eventType: EventType, idKey: String, fetch: @escaping @Sendable (APIClient, String) async throws -> Record) {
        self.id = id
        self.eventType = eventType
        self.idKey = idKey
        self.fetch = fetch
    }

    func load(api: APIClient) async {
        do {
            record = try await fetch(api, id)
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    func handle(_ event: StreamEvent, api: APIClient) async {
        guard event.type == eventType, event.data[idKey]?.stringValue == id else { return }
        await load(api: api)
    }
}

/// Threads JARVIS watches for replies, with "Stop watching".
@MainActor
@Observable
final class EmailWatchesModel {
    private(set) var items: [EmailWatch] = []
    private(set) var hasLoaded = false
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var stoppingIds: Set<String> = []

    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    var watching: [EmailWatch] { items.filter { $0.status == .watching } }
    var ended: [EmailWatch] { items.filter { $0.status != .watching } }

    func load(api: APIClient) async {
        isLoading = true
        defer { isLoading = false }
        do {
            items = try await api.emailWatches()
            hasLoaded = true
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    func stop(_ watch: EmailWatch, api: APIClient) async {
        guard watch.status == .watching, !stoppingIds.contains(watch.id) else { return }
        stoppingIds.insert(watch.id)
        defer { stoppingIds.remove(watch.id) }
        do {
            try await api.stopEmailWatch(id: watch.id)
        } catch is CancellationError {
            return
        } catch let error as ApiError where error.code == .notFound {
            // Gone already: the reload shows that.
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
        await load(api: api)
    }

    func handle(_ event: StreamEvent, api: APIClient) {
        guard event.type == .emailWatchChanged || event.type == .connectionChanged else { return }
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await self?.load(api: api)
        }
    }
}
