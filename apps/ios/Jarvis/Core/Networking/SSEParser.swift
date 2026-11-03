import Foundation

/// Splits a Server-Sent Events byte stream into lines. Accepts LF, CRLF and lone CR
/// terminators, as the SSE specification requires.
///
/// The stream is read byte by byte (`URLSession.AsyncBytes`) rather than with `.lines`,
/// because `AsyncLineSequence` drops empty lines — and an empty line is what dispatches
/// an SSE event.
struct SSELineSplitter: Sendable {
    private var buffer: [UInt8] = []
    private var previousWasCR = false
    private var atStreamStart = true

    /// Feeds one byte; returns a completed line (without its terminator), if any.
    mutating func push(_ byte: UInt8) -> String? {
        switch byte {
        case 0x0A: // LF
            if previousWasCR {
                previousWasCR = false
                return nil // second half of CRLF
            }
            return flush()
        case 0x0D: // CR
            previousWasCR = true
            return flush()
        default:
            previousWasCR = false
            buffer.append(byte)
            return nil
        }
    }

    private mutating func flush() -> String {
        var line = String(decoding: buffer, as: UTF8.self)
        buffer.removeAll(keepingCapacity: true)
        if atStreamStart {
            atStreamStart = false
            if line.hasPrefix("\u{FEFF}") { line.removeFirst() }
        }
        return line
    }
}

/// One dispatched SSE event.
struct SSEMessage: Sendable, Equatable {
    /// The value of this event's own `id:` field; nil when the event had none
    /// (JARVIS sends ephemeral events, such as answer deltas, without an id).
    var id: String?
    /// The `event:` field, defaulting to "message".
    var event: String
    /// All `data:` lines joined with "\n".
    var data: String
}

/// Incremental parser implementing the "interpreting an event stream" rules of the
/// HTML Living Standard: field parsing, multi-line data, comments, `id` and `retry`.
struct SSEParser: Sendable {
    enum Output: Sendable, Equatable {
        case event(SSEMessage)
        /// A comment line (`: heartbeat`); proves the connection is alive.
        case comment(String)
    }

    /// The last event ID buffer. Persists across events and is what a reconnect sends
    /// as `Last-Event-ID`.
    private(set) var lastEventId: String
    /// The most recent valid `retry:` value, in milliseconds.
    private(set) var retryMilliseconds: Int?

    private var dataLines: [String] = []
    private var eventType = ""
    private var eventId: String?

    init(lastEventId: String = "") {
        self.lastEventId = lastEventId
    }

    mutating func feed(line: String) -> Output? {
        if line.isEmpty { return dispatch() }
        if line.hasPrefix(":") {
            var comment = String(line.dropFirst())
            if comment.hasPrefix(" ") { comment.removeFirst() }
            return .comment(comment)
        }

        let field: String
        var value: String
        if let colon = line.firstIndex(of: ":") {
            field = String(line[..<colon])
            value = String(line[line.index(after: colon)...])
            if value.hasPrefix(" ") { value.removeFirst() }
        } else {
            field = line
            value = ""
        }

        switch field {
        case "event":
            eventType = value
        case "data":
            dataLines.append(value)
        case "id":
            if !value.contains("\u{0}") {
                lastEventId = value
                eventId = value
            }
        case "retry":
            if !value.isEmpty, value.allSatisfy({ $0.isASCII && $0.isNumber }), let ms = Int(value) {
                retryMilliseconds = ms
            }
        default:
            break // unknown fields are ignored
        }
        return nil
    }

    private mutating func dispatch() -> Output? {
        defer {
            dataLines.removeAll()
            eventType = ""
            eventId = nil
        }
        guard !dataLines.isEmpty else { return nil }
        return .event(
            SSEMessage(
                id: eventId,
                event: eventType.isEmpty ? "message" : eventType,
                data: dataLines.joined(separator: "\n")
            )
        )
    }
}
