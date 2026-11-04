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
