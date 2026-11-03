import Foundation
import Observation

@MainActor
@Observable
final class TaskListModel {
    private(set) var filter: TaskListFilter = .all
    private(set) var items: [TaskSummary] = []
    private(set) var nextCursor: String?
    private(set) var hasLoaded = false
    private(set) var isLoading = false
    private(set) var isLoadingMore = false
    private(set) var errorMessage: String?

    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    /// Bumped on every reload so a slow, stale page never overwrites a newer one.
    @ObservationIgnored private var generation = 0

    func select(_ filter: TaskListFilter, api: APIClient) async {
        guard filter != self.filter || !hasLoaded else { return }
        self.filter = filter
        items = []
        nextCursor = nil
        hasLoaded = false
        await reload(api: api)
    }

    func reload(api: APIClient) async {
        generation += 1
        let current = generation
        isLoading = true
        defer { if current == generation { isLoading = false } }
        do {
            let page = try await api.tasks(filter: filter, cursor: nil)
            guard current == generation else { return }
            items = page.items
            nextCursor = page.nextCursor
            hasLoaded = true
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            guard current == generation else { return }
            errorMessage = ErrorText.message(for: error)
        }
    }

    func loadMore(api: APIClient) async {
        guard let cursor = nextCursor, !isLoadingMore, !isLoading else { return }
        let current = generation
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await api.tasks(filter: filter, cursor: cursor)
            guard current == generation else { return }
            let known = Set(items.map(\.id))
            items.append(contentsOf: page.items.filter { !known.contains($0.id) })
            nextCursor = page.nextCursor
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    func handle(_ event: StreamEvent, api: APIClient) {
        switch event.type {
        case .taskCreated, .taskStatusChanged, .taskRetried, .approvalRequested, .approvalDecided,
             .stepSucceeded, .stepFailed, .planReady:
            scheduleRefresh(api: api)
        default:
            return
        }
    }

    func scheduleRefresh(api: APIClient) {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            await self?.reload(api: api)
        }
    }
}
