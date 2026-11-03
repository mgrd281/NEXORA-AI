import Foundation
import Observation

@MainActor
@Observable
final class TaskDetailModel {
    let taskId: String
    private(set) var detail: TaskDetail?
    /// Answer text streamed via `task.answer.delta` since the last load.
    private(set) var streamedAnswer = ""
    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var actionError: String?
    private(set) var isPerformingAction = false

    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    /// One key per retry intent, reused if the same retry is re-sent after a transport
    /// failure (the body must match, so the acknowledgement is part of the intent).
    @ObservationIgnored private var retryIntent: (key: String, acknowledged: Bool)?

    init(taskId: String) {
        self.taskId = taskId
    }

    var answer: String? {
        if let answer = detail?.answer, !answer.isEmpty { return answer }
        return streamedAnswer.isEmpty ? nil : streamedAnswer
    }

    func load(api: APIClient) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let fresh = try await api.task(id: taskId)
            detail = fresh
            if fresh.answer != nil || fresh.status.isTerminal { streamedAnswer = "" }
            loadError = nil
        } catch is CancellationError {
            return
        } catch {
            loadError = ErrorText.message(for: error)
        }
    }

    func handle(_ event: StreamEvent, api: APIClient) {
        guard event.taskId == taskId else { return }
        if event.type == .taskAnswerDelta {
            if let text = event.data["text"]?.stringValue { streamedAnswer += text }
            return
        }
        scheduleRefresh(api: api)
    }

    func scheduleRefresh(api: APIClient) {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await self?.load(api: api)
        }
    }

    func cancel(api: APIClient) async {
        guard !isPerformingAction else { return }
        isPerformingAction = true
        actionError = nil
        defer { isPerformingAction = false }
        do {
            _ = try await api.cancelTask(id: taskId)
            await load(api: api)
        } catch is CancellationError {
            return
        } catch {
            actionError = ErrorText.message(for: error)
            await load(api: api)
        }
    }

    func retry(api: APIClient, acknowledgeUnknownOutcome: Bool) async {
        guard !isPerformingAction else { return }
        isPerformingAction = true
        actionError = nil
        defer { isPerformingAction = false }
        let key: String
        if let intent = retryIntent, intent.acknowledged == acknowledgeUnknownOutcome {
            key = intent.key
        } else {
            key = UUID().uuidString
            retryIntent = (key, acknowledgeUnknownOutcome)
        }
        do {
            _ = try await api.retryTask(
                id: taskId,
                acknowledgeUnknownOutcome: acknowledgeUnknownOutcome,
                idempotencyKey: key
            )
            retryIntent = nil
            streamedAnswer = ""
            await load(api: api)
        } catch is CancellationError {
            return
        } catch let error as ApiError {
            // The server answered, so this attempt is settled; a new tap is a new intent.
            retryIntent = nil
            actionError = ErrorText.message(for: error)
            await load(api: api)
        } catch {
            // Transport failure: keep the key so re-sending cannot retry twice.
            actionError = ErrorText.message(for: error)
        }
    }
}
