import Foundation
import Testing
@testable import Jarvis

@Suite("Decoding contract fixtures")
struct ModelDecodingTests {
    @Test("TaskDetail with steps, approvals, events and evidence")
    func taskDetail() throws {
        let detail = try Fixtures.decode(TaskDetail.self, "task-detail")

        #expect(detail.id == "7c415ea2-cacf-462b-8a9f-470f9ce34759")
        #expect(detail.status == .awaitingApproval)
        #expect(detail.riskLevel == .medium)
        #expect(detail.source == .voice)
        #expect(detail.progress == TaskProgress(completed: 2, total: 3))
        #expect(detail.planner == PlannerInfo(mode: .offline, provider: nil, model: nil))
        #expect(detail.answer == nil)
        #expect(detail.canCancel)
        #expect(!detail.canRetry)
        #expect(detail.cost.estimatedMicroUsd == 1200)

        // Steps
        try #require(detail.steps.count == 3)
        let fetch = detail.steps[0]
        #expect(fetch.toolId == .webFetch)
        #expect(fetch.status == .succeeded)
        #expect(fetch.policy.decision == .allow)
        #expect(fetch.inputPreview["url"]?.stringValue == "https://example.org")
        #expect(fetch.output?["status"]?.numberValue == 200)
        #expect(fetch.output?["truncated"]?.boolValue == false)
        #expect(fetch.evidence.map(\.kind) == [.httpResponse, .contentHash])
        let email = detail.steps[2]
        #expect(email.status == .awaitingApproval)
        #expect(email.requiresApproval)
        #expect(email.policy.decision == .requireApproval)
        #expect(email.policy.reasons == ["RISK_MEDIUM", "RECIPIENT_SELF"])
        let recipients: [JSONValue]? = email.inputPreview["to"]?.arrayValue
        #expect(recipients == [JSONValue.string("owner@example.com")])
        #expect(email.output == nil)
        #expect(email.startedAt == nil)

        // Approval with the exact email
        let approval = try #require(detail.pendingApproval)
        #expect(approval.id == detail.pendingApprovalId)
        #expect(approval.status == .pending)
        #expect(approval.actionHash == "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a")
        #expect(approval.isReviewable)
        guard case .email(let message) = approval.details else {
            Issue.record("Expected email details, got \(approval.details)")
            return
        }
        #expect(message.from == "JARVIS <jarvis@example.com>")
        #expect(message.to == ["owner@example.com"])
        #expect(message.subject == "Summary: Example Domain")
        #expect(message.body.hasPrefix("Example Domain\n\n"))

        // History
        #expect(detail.events.map(\.type) == [
            .taskCreated, .taskStatusChanged, .planReady, .stepStarted, .stepSucceeded,
            .approvalRequested, .taskStatusChanged,
        ])
        #expect(detail.events[1].data["to"]?.stringValue == "PLANNING")
        #expect(detail.events[2].data["stepCount"]?.numberValue == 3)
    }

    @Test("Timestamps with fractional seconds, without them, and with numeric offsets")
    func timestamps() throws {
        let detail = try Fixtures.decode(TaskDetail.self, "task-detail")
        // 2026-11-03T15:04:05.123Z
        #expect(abs(detail.createdAt.timeIntervalSince1970 - 1_793_718_245.123) < 0.0005)
        // 2026-11-03T17:04:09.000+02:00 == 15:04:09Z
        #expect(detail.updatedAt.timeIntervalSince1970 == 1_793_718_249)
        // 2026-11-03T15:04:09+00:00 (no fraction)
        #expect(detail.approvals[0].createdAt.timeIntervalSince1970 == 1_793_718_249)

        #expect(JSONCoding.parseDate("2026-11-03T15:04:05Z") != nil)
        #expect(JSONCoding.parseDate("2026-11-03 15:04:05") == nil)
        #expect(JSONCoding.parseDate("yesterday") == nil)
    }

    @Test("HomeSnapshot")
    func homeSnapshot() throws {
        let home = try Fixtures.decode(HomeSnapshot.self, "home-snapshot")
        #expect(home.assistant.planner.mode == .offline)
        #expect(home.assistant.planner.reason == "NO_API_KEY")
        #expect(home.assistant.worker.healthy)
        #expect(home.assistant.capabilities.generalQuestions == false)
        #expect(home.pendingApprovals.count == 1)
        #expect(home.activeTasks.map(\.status) == [.awaitingApproval])
        #expect(home.recentTasks.map(\.status) == [.completed, .failed])
        #expect(home.recentTasks[1].error?.code == .outcomeUnknown)
        #expect(home.recentTasks[1].error?.retryable == false)
        #expect(home.unreadNotifications == 2)
        #expect(home.suggestions.map(\.kind) == [.review, .command])
        #expect(home.suggestions[1].command == nil)
        #expect(HomeCopy.suggestion(home.suggestions[0]) != nil)
        #expect(HomeCopy.plannerNotice(home.assistant) != nil)
        #expect(HomeCopy.workerNotice(home.assistant) == nil)
    }

    @Test("ApiErrorBody maps to ApiError")
    func apiErrorBody() throws {
        let data = try Fixtures.data("api-error")
        let body = try JSONCoding.makeDecoder().decode(ApiErrorBody.self, from: data)
        #expect(body.error.code == .validationFailed)
        #expect(body.error.requestId == "req-6f1c2a9e")

        let error = ApiError.from(data: data, httpStatus: 400, decoder: JSONCoding.makeDecoder())
        #expect(error.code == .validationFailed)
        #expect(error.message == "Invalid body")
        #expect(error.requestId == "req-6f1c2a9e")
        #expect(error.httpStatus == 400)
        let issue = try #require(error.details?["issues"]?.arrayValue?.first)
        guard case .object(let fields) = issue else {
            Issue.record("Expected an object issue")
            return
        }
        #expect(fields["path"]?.stringValue == "request")
    }

    @Test("Non-JSON error bodies fall back to the HTTP status")
    func nonJSONError() {
        let html = Data("<html>Bad gateway</html>".utf8)
        let decoder = JSONCoding.makeDecoder()
        #expect(ApiError.from(data: html, httpStatus: 502, decoder: decoder).code == .internalError)
        #expect(ApiError.from(data: html, httpStatus: 401, decoder: decoder).code == .unauthenticated)
        #expect(ApiError.from(data: Data(), httpStatus: 429, decoder: decoder).code == .rateLimited)
        #expect(ApiError.from(data: Data(), httpStatus: 418, decoder: decoder).code == .unknown)
    }

    @Test("Unknown enum values decode to .unknown instead of failing")
    func unknownValues() throws {
        let detail = try Fixtures.decode(TaskDetail.self, "unknown-values")
        #expect(detail.status == .unknown)
        #expect(detail.riskLevel == .unknown)
        #expect(detail.source == .unknown)
        #expect(detail.planner?.mode == .unknown)
        #expect(detail.error?.code == .unknown)
        #expect(detail.steps[0].status == .unknown)
        #expect(detail.steps[0].toolId == .unknown)
        #expect(detail.steps[0].policy.decision == .unknown)
        #expect(detail.steps[0].evidence[0].kind == .unknown)
        #expect(detail.approvals[0].status == .unknown)
        #expect(detail.events[0].type == .unknown)
        // An approval this build cannot display is never approvable.
        #expect(detail.approvals[0].details == ApprovalDetails.unknown(kind: "video_call"))
        #expect(!detail.approvals[0].isReviewable)
        // Known values elsewhere are untouched.
        #expect(detail.steps[1].status == .succeeded)
        #expect(detail.events[1].type == .taskStatusChanged)
    }

    @Test("Generic approval details")
    func genericApproval() throws {
        let approval = try Fixtures.decode(Approval.self, "approval-generic")
        #expect(approval.status == .approved)
        #expect(approval.decisionNote == "Fine")
        #expect(approval.decidedAt != nil)
        guard case .generic(let action) = approval.details else {
            Issue.record("Expected generic details")
            return
        }
        #expect(action.toolId == .memorySave)
        let expected = [
            ApprovalDetails.Generic.Field(label: "Memory", value: "I prefer short answers"),
            ApprovalDetails.Generic.Field(label: "Kind", value: "preference"),
        ]
        #expect(action.fields == expected)
    }

    @Test("Me and LoginResponse")
    func account() throws {
        let login = try Fixtures.decode(LoginResponse.self, "login-response")
        #expect(login.token?.isEmpty == false)
        #expect(login.session.id == "cade17b9-e460-462c-a974-8ccb0270515b")
        let me = login.user
        let standalone = try Fixtures.decode(Me.self, "me")
        #expect(me == standalone)
        #expect(me.locale == .de)
        #expect(me.theme == .dark)
        #expect(me.roles == [.owner])
        #expect(me.preferences.voice.recognitionLocale == .deDE)
        #expect(me.preferences.voice.speakResponses)
        #expect(me.preferences.spending.monthlyAiBudgetUsd == 20)
    }

    @Test("Pages and lists")
    func lists() throws {
        let tasks = try Fixtures.decode(Page<TaskSummary>.self, "task-page")
        #expect(tasks.items.count == 2)
        #expect(tasks.nextCursor != nil)

        let memories = try Fixtures.decode(Page<Memory>.self, "memories-page")
        #expect(memories.nextCursor == nil)
        #expect(memories.items.map(\.kind) == [.preference, .fact])
        #expect(memories.items.map(\.source) == [.assistant, .user])

        let connections = try Fixtures.decode(ItemList<Connection>.self, "connections")
        #expect(connections.items.map(\.provider) == [.smtp, .web])
        #expect(connections.items.map(\.status) == [.active, .error])

        let sessions = try Fixtures.decode(ItemList<SessionInfo>.self, "sessions")
        #expect(sessions.items.map(\.current) == [true, false])
        #expect(sessions.items[1].deviceName == nil)
        #expect(sessions.items[1].platform == .web)
    }

    @Test("Stream events, persisted and ephemeral")
    func streamEvents() throws {
        let decided = try Fixtures.decode(StreamEvent.self, "stream-event")
        #expect(decided.type == .approvalDecided)
        #expect(decided.data["decision"]?.stringValue == "approved")
        #expect(TaskEventText.describe(decided.type, data: decided.data).isEmpty == false)

        let delta = try Fixtures.decode(StreamEvent.self, "stream-event-ephemeral")
        #expect(delta.type == .taskAnswerDelta)
        #expect(delta.id.hasPrefix("eph-"))
        #expect(delta.data["text"]?.stringValue == "The page ")
    }

    @Test("Detail helpers: unknown outcome needs acknowledgement")
    func unknownOutcome() throws {
        let home = try Fixtures.decode(HomeSnapshot.self, "home-snapshot")
        let failed = home.recentTasks[1]
        #expect(failed.error?.code == .outcomeUnknown)
        #expect(failed.status.canRetry)
        #expect(!failed.status.canCancel)
    }
}
