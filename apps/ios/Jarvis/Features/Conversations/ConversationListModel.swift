import Foundation
import Observation

/// Conversation history: most recent activity first, searchable, paged with the server's
/// cursor, refetched when the stream reports a change.
@MainActor
@Observable
final class ConversationListModel {
    private(set) var items: [ConversationSummary] = []
    private(set) var nextCursor: String?
    private(set) var hasLoaded = false
    private(set) var isLoading = false
    private(set) var isLoadingMore = false
    private(set) var errorMessage: String?
    private(set) var deletingIds: Set<String> = []
    var search = ""

    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    /// `ConversationListQuery.q`: trimmed, at most 200 characters.
    var trimmedSearch: String? {
        let value = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value.prefix(contractLength: 200)
    }

    func reload(api: APIClient) async {
        generation += 1
        let current = generation
        isLoading = true
        defer { if current == generation { isLoading = false } }
        do {
            let page = try await api.conversations(search: trimmedSearch, cursor: nil)
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
        guard let cursor = nextCursor, !isLoading, !isLoadingMore else { return }
        let current = generation
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await api.conversations(search: trimmedSearch, cursor: cursor)
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
        case .conversationMessage, .conversationChanged, .taskCreated, .taskStatusChanged,
             .approvalRequested, .approvalDecided, .scheduleChanged:
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

    /// Deletes a conversation with its tasks, messages and files. The server refuses while a
    /// task in it is still active; the error then says so.
    func delete(_ conversation: ConversationSummary, api: APIClient) async {
        guard !deletingIds.contains(conversation.id) else { return }
        deletingIds.insert(conversation.id)
        defer { deletingIds.remove(conversation.id) }
        do {
            try await api.deleteConversation(id: conversation.id)
            items.removeAll { $0.id == conversation.id }
            errorMessage = nil
        } catch let error as ApiError where error.code == .notFound {
            items.removeAll { $0.id == conversation.id }
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }
}
