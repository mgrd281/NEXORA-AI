import Foundation
import Testing
@testable import Jarvis

@Suite("Presence state mapping")
struct PresenceStateTests {
    private let now = Date(timeIntervalSince1970: 1_793_718_300)

    private func derive(_ configure: (inout PresenceInputs) -> Void) -> PresenceState {
        var inputs = PresenceInputs()
        configure(&inputs)
        return PresenceState.derive(from: inputs, now: now)
    }

    @Test("Idle with nothing going on")
    func idle() {
        #expect(derive { _ in } == .idle)
        #expect(derive { $0.connection = .open } == .idle)
        #expect(derive { $0.connection = .connecting } == .idle)
    }

    @Test("Listening wins over everything and clamps the level")
    func listening() {
        let state = derive {
            $0.isListening = true
            $0.audioLevel = 1.7
            $0.connection = .reconnecting(attempt: 2, retryIn: 6)
            $0.pendingApprovalCount = 1
        }
        #expect(state == .listening(level: 1))
        #expect(derive { $0.isListening = true; $0.audioLevel = -1 } == .listening(level: 0))
    }

    @Test("Reconnecting outranks task states (what is shown may be stale)")
    func reconnecting() {
        let state = derive {
            $0.connection = .reconnecting(attempt: 1, retryIn: 3)
            $0.activeTasks = [makeSummary(status: .running, completed: 1, total: 2)]
        }
        #expect(state == .reconnecting)
    }

    @Test("Awaiting when an approval is pending")
    func awaiting() {
        #expect(derive { $0.pendingApprovalCount = 1 } == .awaiting)
        #expect(derive { $0.activeTasks = [makeSummary(status: .awaitingApproval)] } == .awaiting)
        // Approval outranks another task that is running.
        let state = derive {
            $0.activeTasks = [makeSummary(status: .running, completed: 1, total: 3), makeSummary(status: .awaitingApproval)]
        }
        #expect(state == .awaiting)
    }

    @Test("Running reports real step progress")
    func running() {
        #expect(derive { $0.activeTasks = [makeSummary(status: .running, completed: 1, total: 4)] } == .running(progress: 0.25))
        #expect(derive { $0.activeTasks = [makeSummary(status: .verifying, completed: 3, total: 3)] } == .running(progress: 1))
        #expect(derive { $0.activeTasks = [makeSummary(status: .running, completed: 0, total: 0)] } == .running(progress: nil))
    }

    @Test("Planning for queued and planning tasks")
    func planning() {
        #expect(derive { $0.activeTasks = [makeSummary(status: .queued)] } == .planning)
        #expect(derive { $0.activeTasks = [makeSummary(status: .planning)] } == .planning)
        // Running outranks planning.
        let state = derive {
            $0.activeTasks = [makeSummary(status: .planning), makeSummary(status: .running, completed: 1, total: 2)]
        }
        #expect(state == .running(progress: 0.5))
    }

    @Test("A recent outcome shows briefly, then returns to idle")
    func outcomes() {
        let fresh = now.addingTimeInterval(-2)
        let stale = now.addingTimeInterval(-(PresenceState.outcomeDisplayDuration + 1))
        #expect(derive { $0.recentOutcome = PresenceOutcome(status: .completed, observedAt: fresh) } == .completed)
        #expect(derive { $0.recentOutcome = PresenceOutcome(status: .failed, observedAt: fresh) } == .failed)
        #expect(derive { $0.recentOutcome = PresenceOutcome(status: .completed, observedAt: stale) } == .idle)
        #expect(derive { $0.recentOutcome = PresenceOutcome(status: .cancelled, observedAt: fresh) } == .idle)
        // Ongoing work outranks a past outcome.
        let busy = derive {
            $0.recentOutcome = PresenceOutcome(status: .completed, observedAt: fresh)
            $0.activeTasks = [makeSummary(status: .queued)]
        }
        #expect(busy == .planning)
    }

    @Test("Only states that move on their own run the animation timeline")
    func animation() {
        #expect(PresenceState.planning.isContinuouslyAnimated)
        #expect(PresenceState.awaiting.isContinuouslyAnimated)
        #expect(PresenceState.reconnecting.isContinuouslyAnimated)
        #expect(PresenceState.running(progress: nil).isContinuouslyAnimated)
        #expect(!PresenceState.running(progress: 0.5).isContinuouslyAnimated)
        #expect(!PresenceState.idle.isContinuouslyAnimated)
        #expect(!PresenceState.completed.isContinuouslyAnimated)
        #expect(!PresenceState.listening(level: 0.4).isContinuouslyAnimated)
    }

    @Test("Every state has a VoiceOver label")
    func accessibility() {
        let states: [PresenceState] = [
            .idle, .listening(level: 0.5), .planning, .running(progress: 0.5), .running(progress: nil),
            .awaiting, .completed, .failed, .reconnecting,
        ]
        for state in states {
            #expect(!state.accessibilityLabel.isEmpty)
            #expect(!state.caption.isEmpty)
        }
    }
}
