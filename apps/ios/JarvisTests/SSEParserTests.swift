import Foundation
import Testing
@testable import Jarvis

@Suite("Server-Sent Events parsing")
struct SSEParserTests {
    /// Splits `text` into lines with `SSELineSplitter` and feeds them to `parser`.
    private func run(_ text: String, parser: inout SSEParser) -> [SSEParser.Output] {
        var splitter = SSELineSplitter()
        var outputs: [SSEParser.Output] = []
        for byte in Array(text.utf8) {
            if let line = splitter.push(byte), let output = parser.feed(line: line) {
                outputs.append(output)
            }
        }
        return outputs
    }

    private func events(_ outputs: [SSEParser.Output]) -> [SSEMessage] {
        outputs.compactMap { output in
            if case .event(let message) = output { return message }
            return nil
        }
    }

    @Test("A persisted event as the JARVIS server writes it")
    func serverFraming() throws {
        let json = #"{"id":"42","type":"task.status_changed","taskId":"7c415ea2-cacf-462b-8a9f-470f9ce34759","at":"2026-11-03T15:04:05.300Z","data":{"from":"QUEUED","to":"PLANNING"}}"#
        var parser = SSEParser()
        let outputs = run("retry: 3000\n\nid: 42\nevent: message\ndata: \(json)\n\n", parser: &parser)

        #expect(parser.retryMilliseconds == 3000)
        let message = try #require(events(outputs).first)
        #expect(message.id == "42")
        #expect(message.event == "message")
        #expect(message.data == json)
        #expect(parser.lastEventId == "42")

        let event = try JSONCoding.makeDecoder().decode(StreamEvent.self, from: Data(message.data.utf8))
        #expect(event.type == .taskStatusChanged)
        #expect(event.data["to"]?.stringValue == "PLANNING")
    }

    @Test("Multi-line data is joined with newlines")
    func multiLineData() throws {
        var parser = SSEParser()
        let outputs = run("data: first\ndata: second\ndata:third\n\n", parser: &parser)
        let message = try #require(events(outputs).first)
        #expect(message.data == "first\nsecond\nthird")
    }

    @Test("Only one leading space is removed from a value")
    func leadingSpace() throws {
        var parser = SSEParser()
        let outputs = run("data:  two spaces\n\n", parser: &parser)
        #expect(events(outputs).first?.data == " two spaces")
    }

    @Test("Comments (heartbeats) are reported and never dispatch an event")
    func heartbeat() {
        var parser = SSEParser()
        let outputs = run(": heartbeat\n\n:\n\n", parser: &parser)
        #expect(outputs == [SSEParser.Output.comment("heartbeat"), SSEParser.Output.comment("")])
    }

    @Test("Ephemeral events have no id and keep the resume position")
    func ephemeralKeepsLastEventId() {
        var parser = SSEParser()
        let outputs = run(
            "id: 7\ndata: {\"a\":1}\n\nevent: message\ndata: {\"delta\":true}\n\n",
            parser: &parser
        )
        let messages = events(outputs)
        #expect(messages.count == 2)
        #expect(messages[0].id == "7")
        #expect(messages[1].id == nil)
        #expect(parser.lastEventId == "7")
    }

    @Test("Reconnect resumes from the last id seen")
    func reconnectId() {
        var parser = SSEParser(lastEventId: "100")
        #expect(parser.lastEventId == "100")
        _ = run("id: 101\ndata: x\n\nid: 102\ndata: y\n\n", parser: &parser)
        #expect(parser.lastEventId == "102")

        // A fresh parser for the next connection starts from the stored position.
        var next = SSEParser(lastEventId: parser.lastEventId)
        _ = run(": heartbeat\n\n", parser: &next)
        #expect(next.lastEventId == "102")
    }

    @Test("An empty id resets the position; an id containing NULL is ignored")
    func idEdgeCases() {
        var parser = SSEParser(lastEventId: "5")
        _ = run("id: bad\u{0}id\ndata: x\n\n", parser: &parser)
        #expect(parser.lastEventId == "5")
        _ = run("id\ndata: y\n\n", parser: &parser)
        #expect(parser.lastEventId == "")
    }

    @Test("Blank lines without data dispatch nothing; event type resets per event")
    func dispatchRules() {
        var parser = SSEParser()
        let outputs = run("event: custom\n\ndata: a\n\n", parser: &parser)
        let messages = events(outputs)
        #expect(messages.count == 1)
        #expect(messages[0].event == "message")
    }

    @Test("Invalid retry values are ignored; unknown fields are ignored")
    func retryAndUnknownFields() {
        var parser = SSEParser()
        _ = run("retry: soon\nfoo: bar\ndata: x\n\n", parser: &parser)
        #expect(parser.retryMilliseconds == nil)
        _ = run("retry: 1500\n\n", parser: &parser)
        #expect(parser.retryMilliseconds == 1500)
    }

    @Test("CRLF, CR and LF line endings, and a leading BOM")
    func lineEndings() {
        var parser = SSEParser()
        let outputs = run("\u{FEFF}id: 1\r\ndata: crlf\r\n\r\nid: 2\rdata: cr\r\rid: 3\ndata: lf\n\n", parser: &parser)
        let messages = events(outputs)
        #expect(messages.map(\.data) == ["crlf", "cr", "lf"])
        #expect(messages.map(\.id) == ["1", "2", "3"])
    }

    @Test("UTF-8 split across bytes is reassembled")
    func utf8() {
        var parser = SSEParser()
        let outputs = run("data: مرحبا · Grüße\n\n", parser: &parser)
        #expect(events(outputs).first?.data == "مرحبا · Grüße")
    }

    @Test("Reconnect delay doubles from the server's retry and is capped")
    func reconnectDelay() {
        let delay = { (attempt: Int, jitter: Double) in
            EventStream.reconnectDelay(attempt: attempt, base: 3, maxDelay: 30, jitter: jitter)
        }
        #expect(delay(1, 1) == 3)
        #expect(delay(2, 1) == 6)
        #expect(delay(3, 1) == 12)
        #expect(delay(4, 1) == 24)
        #expect(delay(5, 1) == 30)
        #expect(delay(50, 1) == 30)
        #expect(delay(1, 1.2) == 3 * 1.2)
        #expect(delay(1, 5) == 3 * 1.2) // jitter is clamped to ±20 %
        #expect(EventStream.reconnectDelay(attempt: 1, base: 0, maxDelay: 30, jitter: 1) == 0.5)
    }
}
