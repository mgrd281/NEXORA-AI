import Foundation

/// What JARVIS is doing right now — the same states as the web Presence indicator.
/// Always derived from real inputs (voice capture, stream connection, task data);
/// never animated for effect.
enum PresenceState: Sendable, Equatable {
    case idle
    /// Capturing voice; `level` is the live input level, 0...1.
    case listening(level: Double)
    /// A task is queued or being planned.
    case planning
    /// A task is executing; `progress` is completed/total steps, nil while unknown.
    case running(progress: Double?)
    /// Something needs the user's approval.
    case awaiting
    /// A task just completed.
    case completed
    /// A task just failed.
    case failed
    /// The realtime connection dropped; what is shown may be out of date.
    case reconnecting
}

/// A task outcome observed on the event stream, shown briefly as completed/failed.
struct PresenceOutcome: Sendable, Equatable {
    let status: TaskStatus
    let observedAt: Date
}

struct PresenceInputs: Sendable, Equatable {
    var isListening = false
    var audioLevel = 0.0
    var connection: StreamConnectionState = .idle
    var pendingApprovalCount = 0
    var activeTasks: [TaskSummary] = []
    var recentOutcome: PresenceOutcome?
}

extension PresenceState {
    /// How long a completed/failed outcome stays visible.
    static let outcomeDisplayDuration: TimeInterval = 6

    /// Priority: listening > reconnecting > awaiting > running > planning > recent outcome > idle.
    static func derive(from inputs: PresenceInputs, now: Date = Date()) -> PresenceState {
        if inputs.isListening {
            return .listening(level: min(1, max(0, inputs.audioLevel)))
        }
        if case .reconnecting = inputs.connection {
            return .reconnecting
        }
        if inputs.pendingApprovalCount > 0
            || inputs.activeTasks.contains(where: { $0.status == .awaitingApproval }) {
            return .awaiting
        }
        if let running = inputs.activeTasks.first(where: { $0.status == .running || $0.status == .verifying }) {
            return .running(progress: running.progress.fraction)
        }
        if inputs.activeTasks.contains(where: { $0.status == .queued || $0.status == .planning }) {
            return .planning
        }
        if let outcome = inputs.recentOutcome {
            let age = now.timeIntervalSince(outcome.observedAt)
            if age >= 0, age < outcomeDisplayDuration {
                switch outcome.status {
                case .completed: return .completed
                case .failed: return .failed
                default: break
                }
            }
        }
        return .idle
    }

    /// Whether the indicator moves on its own (and so needs a running timeline).
    var isContinuouslyAnimated: Bool {
        switch self {
        case .planning, .awaiting, .reconnecting: true
        case .running(let progress): progress == nil
        case .idle, .listening, .completed, .failed: false
        }
    }

    /// Spoken by VoiceOver.
    var accessibilityLabel: String {
        switch self {
        case .idle:
            String(localized: "JARVIS is ready")
        case .listening:
            String(localized: "JARVIS is listening")
        case .planning:
            String(localized: "JARVIS is planning")
        case .running(let progress):
            if let progress {
                String(localized: "JARVIS is working, \(progress.formatted(.percent.precision(.fractionLength(0)))) done")
            } else {
                String(localized: "JARVIS is working")
            }
        case .awaiting:
            String(localized: "JARVIS is waiting for your approval")
        case .completed:
            String(localized: "Task completed")
        case .failed:
            String(localized: "Task failed")
        case .reconnecting:
            String(localized: "Reconnecting to JARVIS")
        }
    }

    /// Short caption shown next to the indicator.
    var caption: String {
        switch self {
        case .idle: String(localized: "Ready")
        case .listening: String(localized: "Listening")
        case .planning: String(localized: "Planning")
        case .running(let progress):
            if let progress {
                String(localized: "Working · \(progress.formatted(.percent.precision(.fractionLength(0))))")
            } else {
                String(localized: "Working")
            }
        case .awaiting: String(localized: "Needs your approval")
        case .completed: String(localized: "Done")
        case .failed: String(localized: "Something failed")
        case .reconnecting: String(localized: "Reconnecting…")
        }
    }
}
