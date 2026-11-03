import Foundation

/// The task lifecycle from packages/contracts/src/task-state.ts. The server enforces it;
/// the app uses it only to decide which controls to offer, never to fake a state.
extension TaskStatus {
    static let terminal: Set<TaskStatus> = [.completed, .failed, .cancelled, .expired]
    static let active: Set<TaskStatus> = [.queued, .planning, .awaitingApproval, .running, .verifying]

    static let transitions: [TaskStatus: Set<TaskStatus>] = [
        .queued: [.planning, .cancelled, .expired, .failed],
        .planning: [.running, .awaitingApproval, .failed, .cancelled],
        .awaitingApproval: [.running, .cancelled, .expired, .failed],
        .running: [.awaitingApproval, .verifying, .failed, .cancelled],
        .verifying: [.completed, .failed],
        .completed: [],
        .failed: [.queued],
        .cancelled: [],
        .expired: [.queued],
    ]

    var isTerminal: Bool { Self.terminal.contains(self) }
    var isActive: Bool { Self.active.contains(self) }

    func canTransition(to next: TaskStatus) -> Bool {
        Self.transitions[self]?.contains(next) ?? false
    }

    var canCancel: Bool { canTransition(to: .cancelled) }
    var canRetry: Bool { canTransition(to: .queued) }
}
