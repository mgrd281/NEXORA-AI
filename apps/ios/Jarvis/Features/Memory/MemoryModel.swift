import Foundation
import Observation

@MainActor
@Observable
final class MemoryModel {
    private(set) var items: [Memory] = []
    private(set) var nextCursor: String?
    private(set) var hasLoaded = false
    private(set) var isLoading = false
    private(set) var isLoadingMore = false
    private(set) var errorMessage: String?
    private(set) var deletingIds: Set<String> = []
    var search = ""

    @ObservationIgnored private var generation = 0

    private var trimmedSearch: String? {
        let value = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value.prefix(contractLength: 200)
    }

    func reload(api: APIClient) async {
        generation += 1
        let current = generation
        isLoading = true
        defer { if current == generation { isLoading = false } }
        do {
            let page = try await api.memories(search: trimmedSearch, cursor: nil)
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
            let page = try await api.memories(search: trimmedSearch, cursor: cursor)
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

    /// Saves a memory; returns nil on success or a user-facing error message.
    func add(kind: MemoryKind, content: String, api: APIClient) async -> String? {
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.contractLength <= 1000 else {
            return String(localized: "A memory needs between 1 and 1,000 characters.")
        }
        do {
            let created = try await api.createMemory(kind: kind, content: text)
            items.insert(created, at: 0)
            return nil
        } catch {
            return ErrorText.message(for: error)
        }
    }

    func delete(_ memory: Memory, api: APIClient) async {
        guard !deletingIds.contains(memory.id) else { return }
        deletingIds.insert(memory.id)
        defer { deletingIds.remove(memory.id) }
        do {
            try await api.deleteMemory(id: memory.id)
            items.removeAll { $0.id == memory.id }
        } catch let error as ApiError where error.code == .notFound {
            // Already gone on the server: reflect that.
            items.removeAll { $0.id == memory.id }
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }
}
