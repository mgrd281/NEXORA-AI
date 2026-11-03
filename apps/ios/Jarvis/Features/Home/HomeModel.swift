import Foundation
import Observation

@MainActor
@Observable
final class HomeModel {
    private(set) var snapshot: HomeSnapshot?
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    func load(api: APIClient) async {
        isLoading = true
        defer { isLoading = false }
        do {
            snapshot = try await api.home()
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    /// Coalesces bursts of stream events into one refetch.
    func scheduleRefresh(api: APIClient) {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await self?.load(api: api)
        }
    }

    func handle(_ event: StreamEvent, api: APIClient) {
        switch event.type {
        case .heartbeat, .taskAnswerDelta, .unknown:
            return
        default:
            scheduleRefresh(api: api)
        }
    }

    func presenceInputs(connection: StreamConnectionState, isListening: Bool, outcome: PresenceOutcome?) -> PresenceInputs {
        PresenceInputs(
            isListening: isListening,
            audioLevel: 0,
            connection: connection,
            pendingApprovalCount: snapshot?.pendingApprovals.count ?? 0,
            activeTasks: snapshot?.activeTasks ?? [],
            recentOutcome: outcome
        )
    }
}

/// Text submission state. Keeps one idempotency key per distinct request text, so
/// re-sending after a network failure replays instead of creating a second task.
@MainActor
@Observable
final class ComposerModel {
    var text = ""
    private(set) var isSubmitting = false
    private(set) var errorMessage: String?

    @ObservationIgnored private var keyedText: String?
    @ObservationIgnored private var idempotencyKey = UUID().uuidString

    var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    var canSubmit: Bool { !isSubmitting && !trimmed.isEmpty && trimmed.contractLength <= 4000 }

    func submit(app: AppModel) async -> TaskSummary? {
        guard canSubmit else { return nil }
        let request = trimmed
        if keyedText != request {
            keyedText = request
            idempotencyKey = UUID().uuidString
        }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            let task = try await app.submitTask(
                request,
                source: .text,
                language: AppLocale.current,
                idempotencyKey: idempotencyKey
            )
            text = ""
            keyedText = nil
            return task
        } catch is CancellationError {
            return nil
        } catch {
            errorMessage = ErrorText.message(for: error)
            return nil
        }
    }

    func clearError() { errorMessage = nil }
}
