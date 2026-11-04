import Foundation
import Testing
@testable import Jarvis

/// Phase B request bodies, client-side file checks, recurrence wording, thread merging and
/// server-sentence rendering.
@Suite("Phase B requests and client logic")
struct PhaseBLogicTests {
    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONCoding.makeEncoder().encode(value)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: Request bodies

    @Test("Follow-ups name attachments only when there are some")
    func followUpBody() throws {
        let plain = try json(FollowUpRequest(request: "email it to me", source: .text, language: .en, voiceSessionId: nil))
        #expect(Set(plain.keys) == ["request", "source", "language"])

        let withFiles = try json(CreateTaskRequest(
            request: "Summarize these",
            source: .text,
            language: nil,
            voiceSessionId: nil,
            attachmentIds: ["f5a6b7c8-d9e0-4f1a-8b3c-4d5e6f7a8b95"]
        ))
        #expect(Set(withFiles.keys) == ["request", "source", "attachmentIds"])
        #expect(withFiles["attachmentIds"] as? [String] == ["f5a6b7c8-d9e0-4f1a-8b3c-4d5e6f7a8b95"])
    }

    @Test("Retention: keep-until-deleted is an explicit null, unchanged fields are omitted")
    func retentionPatch() throws {
        let patch = try json(UpdateMeRequest(preferences: PreferencesPatch(
            retention: PreferencesPatch.Retention(memoryDays: .forever, taskHistoryDays: nil)
        )))
        let preferences = try #require(patch["preferences"] as? [String: Any])
        let retention = try #require(preferences["retention"] as? [String: Any])
        #expect(Set(retention.keys) == ["memoryDays"])
        #expect(retention["memoryDays"] is NSNull)

        let days = try json(PreferencesPatch.Retention(memoryDays: nil, taskHistoryDays: .days(365)))
        #expect(Set(days.keys) == ["taskHistoryDays"])
        #expect(days["taskHistoryDays"] as? Int == 365)

        let zone = try json(UpdateMeRequest(timeZone: "Europe/Berlin"))
        #expect(Set(zone.keys) == ["timeZone"])
    }

    @Test("Retention choices mirror MEMORY_RETENTION_DAYS and TASK_HISTORY_RETENTION_DAYS")
    func retentionChoices() {
        #expect(RetentionSetting.memoryChoices.map(\.days) == [nil, 30, 90, 365])
        #expect(RetentionSetting.taskHistoryChoices.map(\.days) == [nil, 90, 365])
        #expect(RetentionSetting(days: nil) == .forever)
        #expect(RetentionSetting(days: 90) == .days(90))
    }

    @Test("Schedule bodies send only the fields of their frequency")
    func scheduleBodies() throws {
        let weekly = Recurrence(frequency: .weekly, byWeekday: [.monday, .friday], time: "09:00", timeZone: "Europe/Berlin")
        let create = try json(CreateScheduleRequest(title: "Weekly", request: "Summarize https://example.com", recurrence: weekly))
        #expect(Set(create.keys) == ["title", "request", "recurrence"])
        let recurrence = try #require(create["recurrence"] as? [String: Any])
        #expect(Set(recurrence.keys) == ["frequency", "interval", "byWeekday", "time", "timeZone"])
        #expect(recurrence["byWeekday"] as? [String] == ["MO", "FR"])
        #expect(recurrence["interval"] as? Int == 1)

        let monthly = Recurrence(frequency: .monthly, byMonthDay: [-1], time: "17:30", timeZone: "UTC", count: 12)
        let monthlyJSON = try json(monthly)
        #expect(Set(monthlyJSON.keys) == ["frequency", "interval", "byMonthDay", "time", "timeZone", "count"])
        #expect(monthlyJSON["byMonthDay"] as? [Int] == [-1])

        let rename = try json(UpdateScheduleRequest(title: "Renamed"))
        #expect(Set(rename.keys) == ["title"])

        let preview = try json(SchedulePreviewRequest(recurrence: weekly, count: 3))
        #expect(preview["count"] as? Int == 3)

        let skill = try json(UpdateSkillRequest(enabled: false))
        #expect(skill["enabled"] as? Bool == false)
    }

    @Test("Recurrence decodes interval 1 when absent and reads its local time")
    func recurrenceFields() throws {
        let data = Data(#"{"frequency":"daily","time":"07:05","timeZone":"Asia/Tokyo"}"#.utf8)
        let recurrence = try JSONCoding.makeDecoder().decode(Recurrence.self, from: data)
        #expect(recurrence.interval == 1)
        #expect(recurrence.hourMinute?.hour == 7)
        #expect(recurrence.hourMinute?.minute == 5)
        #expect(recurrence.isFullyKnown)
        #expect(Recurrence.timeString(hour: 9, minute: 0) == "09:00")
        #expect(Recurrence.timeString(hour: 23, minute: 59) == "23:59")
        #expect(Recurrence(frequency: .daily, time: "9", timeZone: "UTC").hourMinute == nil)
    }

    // MARK: Attachments

    @Test("Files are checked by extension, size and content before uploading")
    func attachmentChecks() {
        let pdf = Data("%PDF-1.7\n1 0 obj\n".utf8)
        #expect(AttachmentPolicy.check(filename: "report.PDF", data: pdf) == .success(.pdf))
        #expect(AttachmentPolicy.check(filename: "report.pdf", data: Data("hello".utf8)) == .failure(.contentMismatch))
        #expect(AttachmentPolicy.check(filename: "photo.png", data: pdf) == .failure(.unsupportedType))
        #expect(AttachmentPolicy.check(filename: "empty.md", data: Data()) == .failure(.empty))

        var docx = Data([0x50, 0x4B, 0x03, 0x04])
        docx.append(Data("....[Content_Types].xml....word/document.xml....".utf8))
        #expect(AttachmentPolicy.check(filename: "letter.docx", data: docx) == .success(.docx))
        #expect(AttachmentPolicy.check(filename: "letter.docx", data: Data([0x50, 0x4B, 0x03, 0x04])) == .failure(.contentMismatch))

        let csv = Data("name,amount\nA,1\n".utf8)
        #expect(AttachmentPolicy.check(filename: "table.csv", data: csv) == .success(.csv))
        #expect(AttachmentPolicy.check(filename: "notes.markdown", data: Data("# Notes".utf8)) == .success(.markdown))
        #expect(AttachmentPolicy.check(filename: "binary.txt", data: Data([0x41, 0x00, 0x42])) == .failure(.contentMismatch))

        let tooLarge = Data(count: Int(AttachmentPolicy.maxBytes) + 1)
        #expect(AttachmentPolicy.check(filename: "big.txt", data: tooLarge) == .failure(.tooLarge))
        #expect(AttachmentPolicy.maxPerRequest == 5)
    }

    @Test("File names lose paths, control and bidi-override characters")
    func displayFilenames() {
        #expect(AttachmentPolicy.displayFilename("folder/sub/report.pdf") == "report.pdf")
        #expect(AttachmentPolicy.displayFilename("invoice\u{202E}fdp.exe") == "invoicefdp.exe")
        #expect(AttachmentPolicy.displayFilename("a\u{0007}b.txt") == "ab.txt")
        #expect(AttachmentPolicy.displayFilename("  \u{2066}  ") == "document")
    }

    @Test("The upload is one multipart file part named file")
    func multipartBody() throws {
        let content = Data("Hello, JARVIS".utf8)
        let body = AttachmentPolicy.multipartBody(
            boundary: "jarvis-test",
            filename: "Notes \"Q3\"\r\nX: y.md",
            mediaType: .markdown,
            data: content
        )
        let text = try #require(String(data: body, encoding: .utf8))
        #expect(text.hasPrefix("--jarvis-test\r\n"))
        #expect(text.hasSuffix("\r\n--jarvis-test--\r\n"))
        #expect(text.contains("Content-Disposition: form-data; name=\"file\"; filename=\"Notes %22Q3%22%0D%0AX: y.md\"\r\n"))
        #expect(text.contains("Content-Type: text/markdown\r\n\r\nHello, JARVIS\r\n"))
        // Exactly one part.
        #expect(text.components(separatedBy: "--jarvis-test").count == 3)
    }

    // MARK: Conversations

    @Test("Thread pages merge by task: fresh turns replace stale ones, order is kept, unknown turns are dropped")
    func threadMerge() throws {
        let detail = try Fixtures.decode(ConversationDetail.self, "conversation-detail")
        let turns = detail.turns
        let older = Array(turns.prefix(3))
        let newer = Array(turns.suffix(3))

        let merged = ConversationThreadModel.merge([older, newer])
        #expect(merged.compactMap(\.stableId) == turns.compactMap(\.stableId))
        #expect(ConversationThreadModel.merge([turns, newer]).compactMap(\.stableId) == turns.compactMap(\.stableId))

        let firstTaskId = try #require(turns[0].taskId)
        let refreshed = makeSummary(id: firstTaskId, status: .failed)
        let replaced = ConversationThreadModel.merge([turns, [.task(refreshed)]])
        #expect(replaced.count == 4)
        if case .task(let task) = replaced[0] {
            #expect(task.status == .failed)
        } else {
            Issue.record("Expected the refreshed task first, got \(replaced[0])")
        }

        let unknown = try Fixtures.decode(ConversationDetail.self, "unknown-values-conversation")
        #expect(ConversationThreadModel.merge([unknown.turns]).count == 2)
    }

    // MARK: Server sentences and error copy

    @Test("Server sentences render in the app's language, else fall back to the server text")
    func serverMessages() throws {
        let known = ServerMessage(key: "plan.summarizeDocument", params: ["name": .text("Q3.pdf")])
        let rendered = try #require(known.rendered)
        #expect(rendered.contains("Q3.pdf"))
        #expect(rendered.contains("\u{2068}"))

        let missingParam = ServerMessage(key: "plan.summarizeDocument")
        #expect(missingParam.rendered == nil)
        #expect(Optional(missingParam).rendered(or: "Fallback") == "Fallback")

        let newer = ServerMessage(key: "plan.somethingNew", params: [:])
        #expect(newer.rendered == nil)

        let nested = ServerMessage(key: "result.declined", params: [
            "action": .message(ServerMessage(key: "approval.schedule", params: ["title": .text("Weekly")])),
        ])
        #expect(nested.rendered?.contains("Weekly") == true)

        let event: [String: JSONValue] = [
            "title": .string("Fallback title"),
            "titleMessage": .object(["key": .string("step.clarify"), "params": .object([:])]),
        ]
        let fromJSON = try #require(ServerMessage(json: event["titleMessage"]))
        #expect(fromJSON.key == "step.clarify")
        #expect(ServerMessage(json: .string("step.clarify")) == nil)
        #expect(TaskEventText.describe(.stepStarted, data: event).contains("Ask you for details"))
    }

    @Test("Task error reasons explain the failure; unknown reasons fall back to the code")
    func taskErrorText() {
        let withReason = TaskError(
            code: .toolFailed,
            message: "English developer text",
            retryable: false,
            reason: "DOCUMENT_TOO_MANY_PAGES",
            params: ["max": .number(200)]
        )
        let text = TaskErrorText.describe(withReason)
        #expect(text.contains(200.formatted()))
        #expect(!text.contains("English developer text"))

        let newer = TaskError(code: .toolFailed, message: "English", retryable: true, reason: "SOMETHING_NEW", params: nil)
        #expect(TaskErrorText.describe(newer) == ErrorText.codeMessage(.toolFailed))

        let missingParam = TaskError(code: .toolFailed, message: "English", retryable: true, reason: "DOCUMENT_TOO_MANY_PAGES", params: [:])
        #expect(TaskErrorText.describe(missingParam) == ErrorText.codeMessage(.toolFailed))
    }

    // MARK: Schedules

    @Test("Recurrences are phrased from their fields")
    func recurrenceText() {
        let daily = Recurrence(frequency: .daily, time: "09:00", timeZone: "UTC")
        #expect(!RecurrenceText.describe(daily).isEmpty)

        let weekly = Recurrence(frequency: .weekly, byWeekday: [.monday, .wednesday], time: "09:00", timeZone: "UTC")
        let weeklyText = RecurrenceText.describe(weekly)
        #expect(weeklyText.contains(RecurrenceText.weekdayName(.monday)))
        #expect(weeklyText.contains(RecurrenceText.weekdayName(.wednesday)))

        let workdays = Recurrence(
            frequency: .weekly,
            byWeekday: [.monday, .tuesday, .wednesday, .thursday, .friday],
            time: "08:30",
            timeZone: "UTC"
        )
        #expect(!RecurrenceText.describe(workdays).contains(RecurrenceText.weekdayName(.tuesday)))

        let monthly = Recurrence(frequency: .monthly, byMonthDay: [-1], time: "17:30", timeZone: "UTC", until: "2027-06-30")
        #expect(RecurrenceText.describe(monthly).contains(RecurrenceText.monthDayName(-1)))

        let biweekly = Recurrence(frequency: .weekly, interval: 2, byWeekday: [.friday], time: "10:00", timeZone: "UTC")
        #expect(RecurrenceText.describe(biweekly) != RecurrenceText.describe(
            Recurrence(frequency: .weekly, interval: 1, byWeekday: [.friday], time: "10:00", timeZone: "UTC")
        ))
        #expect(RecurrenceText.intervalText(.daily, interval: 1) != RecurrenceText.intervalText(.daily, interval: 3))
        #expect(RecurrenceText.weekdayName(.unknown) == "unknown")
    }

    @Test("Schedule editor builds the recurrence and keeps rules it can't edit")
    @MainActor
    func scheduleEditor() throws {
        let fresh = ScheduleEditorModel(schedule: nil, defaultTimeZone: "Europe/Berlin")
        #expect(fresh.canEditRecurrence)
        #expect(fresh.validationMessage != nil)
        fresh.title = "Weekly"
        fresh.request = "Summarize https://example.com and email it to me"
        fresh.weekdays = [.friday, .monday]
        #expect(fresh.validationMessage == nil)
        let built = fresh.recurrence
        #expect(built.frequency == .weekly)
        #expect(built.byWeekday == [.monday, .friday])
        #expect(built.byMonthDay == nil)
        #expect(built.time == "09:00")
        #expect(built.timeZone == "Europe/Berlin")
        fresh.weekdays = []
        #expect(fresh.validationMessage != nil)

        fresh.frequency = .monthly
        fresh.monthDay = -1
        #expect(fresh.recurrence.byMonthDay == [-1])
        #expect(fresh.recurrence.byWeekday == nil)
        #expect(fresh.validationMessage == nil)

        let list = try Fixtures.decode(ItemList<Schedule>.self, "schedules")
        let editable = ScheduleEditorModel(schedule: list.items[0], defaultTimeZone: "UTC")
        #expect(editable.canEditRecurrence)
        #expect(editable.recurrence == list.items[0].recurrence)

        let unknown = try Fixtures.decode(ScheduleDetail.self, "unknown-values-schedule")
        let readOnly = ScheduleEditorModel(schedule: unknown.schedule, defaultTimeZone: "UTC")
        #expect(!readOnly.canEditRecurrence)
    }
}
