import Foundation

/// Connection state of the realtime stream, as shown by the Presence indicator.
enum StreamConnectionState: Sendable, Equatable {
    case idle
    case connecting
    case open
    /// The connection dropped; the next attempt starts after `retryIn` seconds.
    case reconnecting(attempt: Int, retryIn: TimeInterval)
    /// The server rejected the session (401); the app must sign in again.
    case unauthorized
}

enum EventStreamOutput: Sendable {
    case state(StreamConnectionState)
    case event(StreamEvent)
}

/// `GET /v1/events` over `URLSession.bytes`, with `Last-Event-ID` resume and
/// exponential, jittered reconnects.
///
/// The server sends `retry: 3000`, a `: heartbeat` comment every 25 s, persisted events
/// with `id:`, and ephemeral events (answer deltas) without one. A connection idle for
/// longer than `idleTimeout` is treated as dead and reopened.
struct EventStream: Sendable {
    let url: URL
    let session: URLSession
    let tokenProvider: @Sendable () async -> String?
    var idleTimeout: TimeInterval = 75
    var maxDelay: TimeInterval = 30

    init(baseURL: URL, session: URLSession = EventStream.makeSession(), tokenProvider: @escaping @Sendable () async -> String?) {
        self.url = APIClient.makeURL(baseURL: baseURL, path: "/v1/events") ?? baseURL
        self.session = session
        self.tokenProvider = tokenProvider
    }

    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 75
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }

    /// Delay before reconnect attempt `attempt` (1-based): the server's `retry` doubled per
    /// failure, capped at `maxDelay`, with ±20% jitter so devices do not reconnect in lockstep.
    static func reconnectDelay(attempt: Int, base: TimeInterval, maxDelay: TimeInterval, jitter: Double) -> TimeInterval {
        let exponent = Double(max(0, min(attempt - 1, 10)))
        let raw = min(maxDelay, max(0.5, base) * pow(2, exponent))
        let clampedJitter = min(1.2, max(0.8, jitter))
        return raw * clampedJitter
    }

    /// Opens the stream. It reconnects until the consuming task is cancelled or the
    /// session is rejected. `lastEventId` resumes after an event the caller already has.
    func connect(lastEventId: String?) -> AsyncStream<EventStreamOutput> {
        let (stream, continuation) = AsyncStream.makeStream(of: EventStreamOutput.self)
        // Detached: the byte loop must never run on the caller's (main) actor.
        let worker = Task.detached(priority: .utility) {
            await run(resumeFrom: lastEventId, continuation: continuation)
            continuation.finish()
        }
        continuation.onTermination = { _ in worker.cancel() }
        return stream
    }

    private enum Failure: Error {
        case status(Int)
    }

    private func run(resumeFrom initialId: String?, continuation: AsyncStream<EventStreamOutput>.Continuation) async {
        let decoder = JSONCoding.makeDecoder()
        var lastEventId = initialId ?? ""
        var retryBase: TimeInterval = 3
        var attempt = 0

        while !Task.isCancelled {
            continuation.yield(.state(.connecting))
            var receivedData = false
            do {
                guard let token = await tokenProvider() else {
                    continuation.yield(.state(.unauthorized))
                    return
                }
                var request = URLRequest(url: url)
                request.timeoutInterval = idleTimeout
                request.cachePolicy = .reloadIgnoringLocalCacheData
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                if !lastEventId.isEmpty {
                    request.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID")
                }

                let (bytes, response) = try await session.bytes(for: request)
                guard let http = response as? HTTPURLResponse else {
                    bytes.task.cancel()
                    throw Failure.status(0)
                }
                if http.statusCode == 401 {
                    bytes.task.cancel()
                    continuation.yield(.state(.unauthorized))
                    return
                }
                guard http.statusCode == 200 else {
                    bytes.task.cancel()
                    throw Failure.status(http.statusCode)
                }
                continuation.yield(.state(.open))

                var splitter = SSELineSplitter()
                var parser = SSEParser(lastEventId: lastEventId)
                for try await byte in bytes {
                    guard let line = splitter.push(byte) else { continue }
                    if !receivedData {
                        receivedData = true
                        attempt = 0
                    }
                    let output = parser.feed(line: line)
                    lastEventId = parser.lastEventId
                    if let ms = parser.retryMilliseconds { retryBase = Double(ms) / 1000 }
                    if case .event(let message) = output,
                       let data = message.data.data(using: .utf8),
                       let event = try? decoder.decode(StreamEvent.self, from: data) {
                        continuation.yield(.event(event))
                    }
                }
                // The server closed the stream (deploy, shutdown): reconnect below.
            } catch {
                if Task.isCancelled { return }
            }

            attempt += 1
            let delay = Self.reconnectDelay(
                attempt: attempt,
                base: retryBase,
                maxDelay: maxDelay,
                jitter: Double.random(in: 0.8...1.2)
            )
            continuation.yield(.state(.reconnecting(attempt: attempt, retryIn: delay)))
            do {
                try await Task.sleep(for: .seconds(delay))
            } catch {
                return // cancelled
            }
        }
    }
}
