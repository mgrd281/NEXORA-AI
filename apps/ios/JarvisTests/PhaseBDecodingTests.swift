import Foundation
import Testing
@testable import Jarvis

/// Phase B contract fixtures (validated against the Zod schemas by
/// scripts/validate-fixtures.ts): conversations, questions, attachments, skills,
/// schedules, time zones, the new approval kinds, and values from newer servers.
@Suite("Decoding Phase B contract fixtures")
struct PhaseBDecodingTests {
    private let conversationId = "2b0f6c1e-8a4d-4f3b-9c2e-5d7a1b3c4e60"
    private let answeredTaskId = "8f3e1a2b-4c5d-4e6f-9a0b-1c2d3e4f5a61"
    private let questionTaskId = "9a4f2b3c-5d6e-4f70-8b1c-2d3e4f5a6b72"

    @Test("ConversationDetail: turns in order, files, answer and clarifying question")
    func conversationDetail() throws {
        let detail = try Fixtures.decode(ConversationDetail.self, "conversation-detail")
        #expect(detail.id == conversationId)
        #expect(detail.taskCount == 3)
        #expect(detail.canFollowUp)
        #expect(detail.activeTaskId == nil)
        #expect(detail.earlierCursor != nil)
        #expect(detail.displayTitle.contains("Quarterly report"))
        try #require(detail.turns.count == 6)

        guard case .userMessage(let request) = detail.turns[0] else {
            Issue.record("Expected the user's request first, got \(detail.turns[0])")
            return
        }
        #expect(request.role == .user)
        #expect(request.kind == .request)
        #expect(request.taskId == answeredTaskId)
        try #require(request.attachments.count == 1)
        let file = request.attachments[0]
        #expect(file.mediaType == .pdf)
        #expect(file.pageCount == 12)
        #expect(file.sizeBytes == 482_113)
        #expect(file.downloadPath == "/v1/attachments/\(file.id)/content")

        guard case .task(let answered) = detail.turns[1] else {
            Issue.record("Expected the task second, got \(detail.turns[1])")
            return
        }
        #expect(answered.outcome == .answer)
        #expect(!answered.needsAnswer)
        #expect(answered.attachmentCount == 1)
        #expect(answered.conversationId == conversationId)

        guard case .assistantMessage(let answer) = detail.turns[2] else {
            Issue.record("Expected JARVIS's answer third, got \(detail.turns[2])")
            return
        }
        #expect(answer.kind == .answer)
        #expect(answer.attachments.isEmpty)

        guard case .task(let asked) = detail.turns[4], case .assistantMessage(let question) = detail.turns[5] else {
            Issue.record("Expected the question task and its message last")
            return
        }
        #expect(asked.needsAnswer)
        #expect(asked.question?.missing == [.emailContent])
        #expect(question.kind == .question)
        #expect(question.textMessage?.key == "question.emailContent")
        #expect(question.displayText == "What should the email say?")

        // Stable ids for lists, and the task each turn belongs to.
        #expect(detail.turns.compactMap(\.stableId).count == 6)
        #expect(detail.turns.map(\.taskId) == [
            answeredTaskId, answeredTaskId, answeredTaskId, questionTaskId, questionTaskId, questionTaskId,
        ])
    }

    @Test("Conversation history page")
    func conversationPage() throws {
        let page = try Fixtures.decode(Page<ConversationSummary>.self, "conversation-page")
        #expect(page.nextCursor == nil)
        try #require(page.items.count == 2)
        #expect(page.items[0].lastTask?.needsAnswer == true)
        #expect(!page.items[0].hasActiveTask)
        let scheduled = page.items[1]
        #expect(scheduled.hasActiveTask)
        #expect(scheduled.scheduleId != nil)
        #expect(scheduled.titleMessage == nil)
        #expect(scheduled.displayTitle == "Weekly AI Act summary")
        #expect(scheduled.lastTask?.source == .schedule)
        #expect(scheduled.lastTask?.pendingApproval?.untrustedSource == false)
    }

    @Test("Attachment metadata of an unattached upload")
    func attachment() throws {
        let file = try Fixtures.decode(Attachment.self, "attachment")
        #expect(file.mediaType == .markdown)
        #expect(file.mediaType.isText)
        #expect(file.conversationId == nil)
        #expect(file.expiresAt != nil)
        #expect(file.pageCount == nil)
    }

    @Test("TaskDetail of a clarifying question with an attached file")
    func questionTask() throws {
        let detail = try Fixtures.decode(TaskDetail.self, "task-detail-question")
        #expect(detail.status == .completed)
        #expect(detail.outcome == .question)
        #expect(detail.needsAnswer)
        let question = try #require(detail.question)
        #expect(question.missing == [.emailContent])
        #expect(question.message?.key == "question.emailContent")
        #expect(question.displayText == "What should the email say?")
        #expect(detail.displayObjective == "Ask you for the information this request needs.")
        #expect(detail.attachments?.count == 1)
        #expect(detail.scheduleId == nil)
        try #require(detail.steps.count == 1)
        #expect(detail.steps[0].toolId == .assistantClarify)
        #expect(detail.steps[0].displayTitle == "Ask you for details")
    }

    @Test("Skills with their availability")
    func skills() throws {
        let list = try Fixtures.decode(ItemList<Skill>.self, "skills")
        try #require(list.items.count == 5)
        let research = list.items[0]
        #expect(research.skillId == .webResearch)
        #expect(research.available)
        #expect(research.tools == [.webFetch, .textSummarize])
        #expect(research.modelUse == .whenAvailable)
        #expect(research.maxCostPerRunMicroUsd == 50_000)
        let email = list.items[1]
        #expect(email.status == .needsConnection)
        #expect(email.unavailableReason == .connectionRequired)
        #expect(email.requiredConnections == [.smtp])
        #expect(email.unavailableText != nil)
        let translation = list.items[2]
        #expect(!translation.enabled)
        #expect(translation.unavailableReason == .disabledByUser)
        #expect(translation.modelUse == .needed)
        let planning = list.items[3]
        #expect(!planning.canToggle)
        #expect(planning.tools.contains(.conversationRecall))
        let phone = list.items[4]
        #expect(phone.status == .planned)
        #expect(phone.plannedTools == ["phone.call"])
        #expect(phone.maxRisk == .high)
    }

    @Test("Schedules: weekly and monthly-on-the-last-day recurrences")
    func schedules() throws {
        let list = try Fixtures.decode(ItemList<Schedule>.self, "schedules")
        try #require(list.items.count == 2)
        let weekly = list.items[0]
        #expect(weekly.status == .active)
        #expect(weekly.createdBy == .agent)
        #expect(weekly.recurrence.frequency == .weekly)
        #expect(weekly.recurrence.byWeekday == [.monday, .thursday])
        #expect(weekly.recurrence.interval == 1)
        #expect(weekly.recurrence.isFullyKnown)
        #expect(weekly.nextRunAt != nil)
        #expect(weekly.stateNote == nil)

        let monthly = list.items[1]
        #expect(monthly.status == .paused)
        #expect(monthly.pausedReason == .failures)
        #expect(monthly.nextRunAt == nil)
        #expect(monthly.recurrence.byMonthDay == [-1])
        #expect(monthly.recurrence.count == 12)
        #expect(monthly.recurrence.byWeekday == nil)
        #expect(monthly.language == .de)
        #expect(monthly.stateNote != nil)
    }

    @Test("ScheduleDetail: upcoming occurrences and runs")
    func scheduleDetail() throws {
        let detail = try Fixtures.decode(ScheduleDetail.self, "schedule-detail")
        #expect(detail.schedule.title == "Weekly AI Act summary")
        #expect(detail.upcoming.count == 3)
        try #require(detail.runs.count == 2)
        #expect(detail.runs[0].status == .created)
        #expect(detail.runs[0].task?.status == .awaitingApproval)
        #expect(detail.runs[1].status == .skipped)
        #expect(detail.runs[1].reason == .budgetExhausted)
        #expect(detail.runs[1].task == nil)
    }

    @Test("Schedule preview and accepted time zones")
    func previewAndTimeZones() throws {
        let preview = try Fixtures.decode(SchedulePreview.self, "schedule-preview")
        #expect(preview.occurrences.count == 3)
        #expect(preview.timeZone == "Europe/Berlin")

        let zones = try Fixtures.decode(ItemList<TimeZoneInfo>.self, "time-zones")
        #expect(zones.items.map(\.id) == ["America/New_York", "Asia/Kolkata", "Europe/Berlin", "UTC"])
        #expect(zones.items.map(\.offsetLabel) == ["UTC\u{2212}05:00", "UTC+05:30", "UTC+01:00", "UTC"])
    }

    @Test("Schedule approval: exact request, recurrence, next runs and untrusted facts")
    func scheduleApproval() throws {
        let approval = try Fixtures.decode(Approval.self, "approval-schedule")
        #expect(approval.toolId == .scheduleCreate)
        #expect(approval.isReviewable)
        #expect(approval.reasons.contains("FUTURE_RUNS"))
        #expect(approval.summaryMessage?.key == "approval.schedule")
        #expect(approval.displaySummary.contains("Weekly AI Act summary"))
        guard case .schedule(let action) = approval.details else {
            Issue.record("Expected schedule details, got \(approval.details)")
            return
        }
        #expect(action.request == "Summarize https://artificialintelligenceact.eu and email it to me")
        #expect(action.recurrence.byWeekday == [.monday])
        #expect(action.nextOccurrences.count == 3)
        let untrusted = try #require(approval.details.untrusted)
        #expect(untrusted.host == "example.net")
        #expect(untrusted.excludedSentences == 2)
        #expect(untrusted.signals == ["ignore_previous_instructions"])
    }

    @Test("Memory approval: exactly the text that would be kept")
    func memoryApproval() throws {
        let approval = try Fixtures.decode(Approval.self, "approval-memory")
        #expect(approval.isReviewable)
        #expect(approval.details.untrusted == nil)
        guard case .memory(let action) = approval.details else {
            Issue.record("Expected memory details, got \(approval.details)")
            return
        }
        #expect(action.content == "Revenue grew 12 % in Q3")
        #expect(action.memoryKind == .fact)
        #expect(action.sourceTaskId == answeredTaskId)
        #expect(approval.displayTaskTitle.contains("Quarterly report"))
    }

    @Test("Conversation stream event")
    func conversationEvent() throws {
        let event = try Fixtures.decode(StreamEvent.self, "stream-event-conversation")
        #expect(event.type == .conversationMessage)
        #expect(event.data["conversationId"]?.stringValue == conversationId)
        #expect(event.data["kind"]?.stringValue == "question")
    }

    @Test("API error reasons explain the refusal in the app's language")
    func apiErrorReasons() throws {
        let busyBody = try Fixtures.data("api-error-conversation-busy")
        let busy = ApiError.from(data: busyBody, httpStatus: 409, decoder: JSONCoding.makeDecoder())
        #expect(busy.code == .invalidState)
        #expect(ErrorText.busyTaskId(busy) == "ab5a3c4d-6e7f-4a81-9c2d-3e4f5a6b7c83")
        #expect(ErrorText.message(for: busy) != ErrorText.codeMessage(.invalidState))
        #expect(ErrorText.message(for: busy).contains("follow-up"))

        let largeBody = try Fixtures.data("api-error-file-too-large")
        let large = ApiError.from(data: largeBody, httpStatus: 413, decoder: JSONCoding.makeDecoder())
        #expect(large.code == .payloadTooLarge)
        let text = ErrorText.message(for: large)
        #expect(text.contains(ByteCountFormatter.string(fromByteCount: 10_485_760, countStyle: .memory)))
    }

    @Test("Values from a newer server decode to .unknown")
    func unknownValues() throws {
        let conversation = try Fixtures.decode(ConversationDetail.self, "unknown-values-conversation")
        try #require(conversation.turns.count == 3)
        if case .unknown(let type) = conversation.turns[0] {
            #expect(type == "system_note")
        } else {
            Issue.record("Expected an unknown turn, got \(conversation.turns[0])")
        }
        #expect(conversation.turns[0].stableId == nil)
        if case .userMessage(let message) = conversation.turns[1] {
            #expect(message.kind == .unknown)
            #expect(message.language == .unknown)
            #expect(message.attachments.map(\.mediaType) == [.unknown])
        } else {
            Issue.record("Expected a user message, got \(conversation.turns[1])")
        }
        if case .task(let task) = conversation.turns[2] {
            #expect(task.outcome == .unknown)
            #expect(task.question?.missing == [.unknown])
            #expect(!task.needsAnswer)
        } else {
            Issue.record("Expected a task, got \(conversation.turns[2])")
        }

        let schedule = try Fixtures.decode(ScheduleDetail.self, "unknown-values-schedule")
        #expect(schedule.schedule.status == .unknown)
        #expect(schedule.schedule.pausedReason == .unknown)
        #expect(schedule.schedule.createdBy == .unknown)
        #expect(schedule.schedule.recurrence.byWeekday == [.monday, .unknown])
        #expect(!schedule.schedule.recurrence.isFullyKnown)
        #expect(schedule.runs.map(\.status) == [.unknown])
        #expect(schedule.runs.map(\.reason) == [.unknown])

        let skills = try Fixtures.decode(ItemList<Skill>.self, "unknown-values-skills")
        let skill = try #require(skills.items.first)
        #expect(skill.id == "home-control")
        #expect(skill.skillId == .unknown)
        #expect(skill.status == .unknown)
        #expect(skill.unavailableReason == .unknown)
        #expect(skill.tools == [.unknown])
        #expect(skill.maxRisk == .unknown)
        #expect(skill.requiredConnections == [.unknown])
        #expect(skill.modelUse == .unknown)
    }

    @Test("Preferences: retention and skills, defaulted for an older server")
    func preferences() throws {
        let me = try Fixtures.decode(Me.self, "me")
        #expect(me.preferences.retention.memoryDays == 90)
        #expect(me.preferences.retention.taskHistoryDays == nil)
        #expect(me.preferences.skills.disabled == [.translation])

        let older = try Fixtures.decode(Me.self, "me-before-phase-b")
        #expect(older.preferences.retention == .keepEverything)
        #expect(older.preferences.skills.disabled.isEmpty)
        #expect(older.preferences.voice == me.preferences.voice)
    }
}
