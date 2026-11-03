import Foundation
import Observation

/// Owns the single realtime connection and fans events out to screens.
///
/// Screens subscribe with `updates()` inside a `.task`, so each subscription ends with
/// the view. `openCount` increments on every successful (re)connect; screens refetch
/// when it changes, which closes any gap the `Last-Event-ID` replay cannot cover.
@MainActor
@Observable
final class LiveEvents {
    private(set) var state: StreamConnectionState = .idle
    private(set) var openCount = 0

    /// Called for every event before subscribers see it (used by `AppModel`).
    @ObservationIgnored var onEvent: ((StreamEvent) -> Void)?
    /// Called when the server rejects the session on the stream.
    @ObservationIgnored var onUnauthorized: (() -> Void)?

    @ObservationIgnored private let stream: EventStream
    @ObservationIgnored private var consumer: Task<Void, Never>?
    @ObservationIgnored private var lastEventId: String?
    @ObservationIgnored private var subscribers: [UUID: AsyncStream<StreamEvent>.Continuation] = [:]

    init(stream: EventStream) {
        self.stream = stream
    }

    var isRunning: Bool { consumer != nil }

    func start() {
        guard consumer == nil else { return }
        let outputs = stream.connect(lastEventId: lastEventId)
        consumer = Task { [weak self] in
            for await output in outputs {
                guard let self else { return }
                self.handle(output)
            }
        }
    }

    func stop() {
        consumer?.cancel()
        consumer = nil
        state = .idle
    }

    /// Reconnects immediately (e.g. when the app returns to the foreground), resuming
    /// after the last event received.
    func restart() {
        stop()
        start()
    }

    /// Forgets the resume position (on sign-out, so another account never resumes it).
    func reset() {
        stop()
        lastEventId = nil
    }

    func updates() -> AsyncStream<StreamEvent> {
        let (stream, continuation) = AsyncStream.makeStream(
            of: StreamEvent.self,
            bufferingPolicy: .bufferingNewest(500)
        )
        subscribers[UUID()] = continuation
        return stream
    }

    private func handle(_ output: EventStreamOutput) {
        switch output {
        case .state(let newState):
            state = newState
            if newState == .open { openCount += 1 }
            if newState == .unauthorized {
                consumer?.cancel()
                consumer = nil
                onUnauthorized?()
            }
        case .event(let event):
            // Only persisted events (numeric ids) move the resume position.
            if !event.id.hasPrefix("eph-"), !event.id.isEmpty {
                lastEventId = event.id
            }
            onEvent?(event)
            for (id, continuation) in subscribers {
                if case .terminated = continuation.yield(event) {
                    subscribers[id] = nil
                }
            }
        }
    }
}
