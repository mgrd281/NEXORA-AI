import Foundation
import Observation

/// One conversation: its turns (oldest first, earlier pages on demand) and whether a
/// follow-up can be sent now. Updates are refetches of the newest page, merged by task so
/// pages loaded earlier are kept and nothing is shown twice.
@MainActor
@Observable
final class ConversationThreadModel {
    let conversationId: String
    /// The newest page as last fetched (title, schedule, `canFollowUp`, `activeTaskId`).
    private(set) var detail: ConversationDetail?
    /// Every turn loaded so far, oldest first.
    private(set) var turns: [ConversationTurn] = []
    /// Where earlier turns continue; nil when everything is loaded.
    private(set) var earlierCursor: String?
    private(set) var isLoading = false
    private(set) var isLoadingEarlier = false
    private(set) var loadError: String?
    private(set) var earlierError: String?
    /// The conversation no longer exists (deleted here, elsewhere or by retention).
    private(set) var isGone = false
    private(set) var isDeleting = false
    private(set) var deleteError: String?

    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var loadedEarlierPages = false

    init(conversationId: String) {
        self.conversationId = conversationId
    }

    /// The task a follow-up has to wait for, as a title in the app's language.
    var activeTaskTitle: String? {
        guard let id = detail?.activeTaskId else { return nil }
        for turn in turns {
            if case .task(let task) = turn, task.id == id { return task.displayTitle }
        }
        return nil
    }

    /// The newest task asked a clarifying question: the next message is its answer.
    var isAwaitingAnswer: Bool {
        for turn in turns.reversed() {
            if case .task(let task) = turn { return task.needsAnswer }
        }
        return false
    }

    /// The newest task's clarifying question, if it asked one.
    var openQuestion: AssistantQuestion? {
        for turn in turns.reversed() {
            if case .task(let task) = turn { return task.needsAnswer ? task.question : nil }
        }
        return nil
    }

    private var knownTaskIds: Set<String> {
        Set(turns.compactMap(\.taskId))
    }

    func load(api: APIClient) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let fresh = try await api.conversation(id: conversationId)
            detail = fresh
            turns = Self.merge([turns, fresh.turns])
            if !loadedEarlierPages { earlierCursor = fresh.earlierCursor }
            loadError = nil
            isGone = false
        } catch is CancellationError {
            return
        } catch let error as ApiError where error.code == .notFound {
            isGone = true
            detail = nil
            turns = []
            earlierCursor = nil
        } catch {
            loadError = ErrorText.message(for: error)
        }
    }

    func loadEarlier(api: APIClient) async {
        guard let cursor = earlierCursor, !isLoadingEarlier else { return }
        isLoadingEarlier = true
        defer { isLoadingEarlier = false }
        do {
            let page = try await api.conversation(id: conversationId, before: cursor)
            turns = Self.merge([page.turns, turns])
            earlierCursor = page.earlierCursor
            loadedEarlierPages = true
            earlierError = nil
        } catch is CancellationError {
            return
        } catch {
            earlierError = ErrorText.message(for: error)
        }
    }

    func handle(_ event: StreamEvent, api: APIClient) {
        switch event.type {
        case .conversationMessage, .conversationChanged:
            guard event.data["conversationId"]?.stringValue == conversationId else { return }
            scheduleRefresh(api: api)
        case .taskCreated:
            // A scheduled run can add a task to this conversation.
            scheduleRefresh(api: api)
        case .taskStatusChanged, .planReady, .stepStarted, .stepSucceeded, .stepFailed, .stepBlocked,
             .approvalRequested, .approvalDecided, .taskRetried, .verificationPassed, .verificationFailed:
            guard let taskId = event.taskId, knownTaskIds.contains(taskId) else { return }
            scheduleRefresh(api: api)
        default:
            return
        }
    }

    func scheduleRefresh(api: APIClient) {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await self?.load(api: api)
        }
    }

    /// Deletes the conversation; returns true when it is gone.
    func delete(api: APIClient) async -> Bool {
        guard !isDeleting else { return false }
        isDeleting = true
        deleteError = nil
        defer { isDeleting = false }
        do {
            try await api.deleteConversation(id: conversationId)
            isGone = true
            return true
        } catch let error as ApiError where error.code == .notFound {
            isGone = true
            return true
        } catch is CancellationError {
            return false
        } catch {
            deleteError = ErrorText.message(for: error)
            return false
        }
    }

    /// Merges pages of turns. Sources are ordered oldest-known first and fresher later: each
    /// task keeps its position from the first source that has it and its turns from the
    /// freshest one. Turns of a type this build does not know are dropped.
    nonisolated static func merge(_ sources: [[ConversationTurn]]) -> [ConversationTurn] {
        var order: [String] = []
        var groups: [String: [ConversationTurn]] = [:]
        for turns in sources {
            var fresh: [String: [ConversationTurn]] = [:]
            var freshOrder: [String] = []
            for turn in turns {
                guard let key = turn.taskId ?? turn.stableId else { continue }
                if fresh[key] == nil { freshOrder.append(key) }
                fresh[key, default: []].append(turn)
            }
            for key in freshOrder {
                if groups[key] == nil { order.append(key) }
                groups[key] = fresh[key]
            }
        }
        return order.flatMap { groups[$0] ?? [] }
    }
}
